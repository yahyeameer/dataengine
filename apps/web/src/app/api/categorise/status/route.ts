import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { requireWorkspaceAccess } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * What is happening to one uploaded file, in words an accountant reads.
 *
 * Two jobs, and the second one is the reason this route exists rather than the
 * screen polling `/api/agent/jobs` directly.
 *
 * **It translates.** The queue speaks in job kinds, stages, attempts and
 * dataset versions. None of that is the customer's business, and a screen that
 * renders it is a screen that has to be understood before it can be used. What
 * leaves here is a list of seven steps and which one is running.
 *
 * **It answers the download question once and unambiguously.** The status is
 * traced from the upload the caller named — upload → its parse job → the
 * categorise job that parse chained → the export that job wrote — so the job id
 * it hands back is the export *of this run*. The result screen has exactly one
 * id and no way to name an older one, which is the whole fix for a customer
 * downloading last week's file and finding no categories in it.
 *
 * The id is not a capability. `/api/exports` re-reads the job through the
 * caller's RLS-bound client and re-derives the storage path server-side, so
 * this route hands over a reference, never an authorisation.
 */

const querySchema = z.object({
  uploadId: z.string().uuid(),
});

/**
 * The seven steps, in the order they happen.
 *
 * Written as work rather than as machinery: "Reading transaction data" is what
 * the parse job is doing, and "parse_workbook" is how it is implemented. The
 * customer is waiting for the first and does not need the second.
 */
const STEPS = [
  { key: 'uploaded', label: 'File uploaded' },
  { key: 'reading', label: 'Reading transaction data' },
  { key: 'identifying', label: 'Identifying transaction columns' },
  { key: 'categorising', label: 'Categorising with HMRC categories' },
  { key: 'validating', label: 'Checking the results' },
  { key: 'preparing', label: 'Preparing your file' },
  { key: 'ready', label: 'Ready to download' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

/**
 * Where each job kind and worker stage sits on that list.
 *
 * The worker reports its own stage on every lease renewal, so this is the real
 * position rather than a spinner that means "something". Anything unrecognised
 * falls back to the job kind's own step, which is why a new stage name in the
 * worker degrades to a slightly coarse progress bar instead of a broken screen.
 */
const STAGE_STEPS: Record<string, StepKey> = {
  downloading: 'reading',
  parsing: 'reading',
  writing: 'reading',
  reading: 'reading',
  identifying: 'identifying',
  categorising: 'categorising',
  recording: 'categorising',
  applying: 'categorising',
  validating: 'validating',
  preparing: 'preparing',
};

const KIND_STEPS: Record<string, StepKey> = {
  parse_workbook: 'reading',
  categorise_statement: 'categorising',
};

/** Every technical failure reaches the customer as this. Detail stays in logs. */
const GENERIC_FAILURE =
  "We couldn't finish processing this file. Your original file is safe — please try again, " +
  'or upload a different file.';

/**
 * Whether a worker message is safe and useful to show.
 *
 * The worker already draws this line: `JobError` carries a sentence written for
 * an accountant, anything else is replaced with a generic message before it is
 * stored. This is the second half of that — a belt-and-braces filter, because
 * the cost of being wrong is a stack trace on a customer's screen.
 */
function customerFacing(message: string | null): string {
  if (!message) return GENERIC_FAILURE;

  const technical = /\b(supabase|postgres|parquet|uuid|traceback|null|undefined|http|sql|500)\b/i;
  if (technical.test(message) || message.length > 240) return GENERIC_FAILURE;

  return message;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const { uploadId } = querySchema.parse({ uploadId: url.searchParams.get('uploadId') });

    const supabase = await createServerSupabase();

    // Read the upload through the caller's own client first: RLS decides whether
    // this upload is visible at all, and only then is its workspace used to
    // re-derive membership. Same two-check shape as /api/exports.
    const { data: upload } = await supabase
      .from('raw_uploads')
      .select('id, workspace_id, dataset_id, original_filename, status')
      .eq('id', uploadId)
      .maybeSingle();

    if (!upload) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
    }

    await requireWorkspaceAccess(upload.workspace_id);

    // Every job this upload caused. The chain is narrow — a parse and the
    // categorise it queued — so ordering by creation and walking it is enough,
    // and it avoids a recursive query for a two-link chain.
    const { data: jobs } = await supabase
      .from('agent_jobs')
      .select(
        'id, kind, status, progress, result, error, created_at, dataset_version_id, raw_upload_id',
      )
      .eq('workspace_id', upload.workspace_id)
      .in('kind', ['parse_workbook', 'categorise_statement'])
      .order('created_at', { ascending: true });

    // The chain, followed by id at every link rather than by time.
    //
    // The parse job is the one whose `raw_upload_id` is this upload. The
    // categorise job is the one whose input is the version that parse produced.
    // Two files dropped a second apart produce two chains, and nothing here can
    // cross them — which is the difference between "your file" and "a file".
    const parseJob = (jobs ?? []).find(
      (job) => job.kind === 'parse_workbook' && job.raw_upload_id === uploadId,
    );
    const parsedVersionId = parseJob
      ? (jobResult(parseJob).dataset_version_id as string | undefined) ?? null
      : null;

    const categoriseJob = parsedVersionId
      ? (jobs ?? []).find(
          (job) =>
            job.kind === 'categorise_statement' &&
            (job.dataset_version_id === parsedVersionId ||
              jobResult(job).parent_version_id === parsedVersionId),
        )
      : undefined;

    const failed = [parseJob, categoriseJob].find((job) => job?.status === 'failed');
    if (failed) {
      return NextResponse.json({
        state: 'failed',
        filename: upload.original_filename,
        message: customerFacing(failed.error),
        steps: renderSteps('reading', 'failed'),
      });
    }

    if (categoriseJob?.status === 'succeeded') {
      const result = jobResult(categoriseJob);
      return NextResponse.json({
        state: 'ready',
        filename: upload.original_filename,
        steps: renderSteps('ready', 'done'),
        summary: {
          transactions: numberOr(result.rows_total, 0),
          categorised: numberOr(result.rows_categorised, 0),
          flagged: numberOr(result.rows_flagged, 0),
          categories: Array.isArray(result.categories) ? result.categories.length : 0,
        },
        // The download, and only this one. Traced from the upload the caller
        // named, so it cannot be an earlier run's file.
        download: { jobId: categoriseJob.id },
      });
    }

    const active = categoriseJob ?? parseJob;
    const current = active ? stepFor(active) : 'uploaded';

    return NextResponse.json({
      state: 'working',
      filename: upload.original_filename,
      steps: renderSteps(current, 'working'),
      // A worker that has not picked the job up yet is not a fault — say so
      // rather than showing a stalled checklist with no explanation.
      queued: !active || active.status === 'queued',
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

function jobResult(job: { result: unknown }): Record<string, unknown> {
  return (job.result ?? {}) as Record<string, unknown>;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function stepFor(job: { kind: string; progress: unknown }): StepKey {
  const progress = (job.progress ?? {}) as Record<string, unknown>;
  const stage = typeof progress.stage === 'string' ? progress.stage : null;
  return (stage && STAGE_STEPS[stage]) || KIND_STEPS[job.kind] || 'reading';
}

/**
 * The checklist, with one step marked as the one happening now.
 *
 * Everything before the current step is done, everything after is waiting. That
 * is a simplification — the worker does not report backwards — and it is the
 * right one: a checklist that un-ticks a step would be alarming and would be
 * describing an implementation detail, not a change in the customer's file.
 */
function renderSteps(current: StepKey, state: 'working' | 'done' | 'failed') {
  const at = STEPS.findIndex((step) => step.key === current);

  return STEPS.map((step, index) => ({
    label: step.label,
    status:
      state === 'done' || index < at
        ? 'done'
        : index === at
          ? state === 'failed'
            ? 'failed'
            : 'active'
          : 'waiting',
  }));
}
