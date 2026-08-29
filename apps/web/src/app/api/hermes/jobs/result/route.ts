import { NextResponse } from 'next/server';
import { z } from 'zod';

import { HERMES_WORKER_ID, JOB_LEASE_SECONDS, verifyCallbackSignature } from '@/lib/hermes';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * Where the agent reports what happened.
 *
 * This is the only route in the application with no signed-in user behind it.
 * Everything else derives authority from a session; this derives it from an
 * HMAC over the raw body, because the caller is a machine on the Docker bridge
 * that has no session and never will.
 *
 * Two rules follow from that, and neither is negotiable:
 *
 * **The body proves who is calling, not what they may touch.** A valid
 * signature means "the agent sent this" and nothing more. The workspace, the
 * org and the dataset are read from the job row, never from the payload -- so an
 * agent that has been prompt-injected into reporting against another firm's job
 * cannot widen its reach, because its reach is not something it sends.
 *
 * **The state machine stays in the database.** This route translates a report
 * into `heartbeat_agent_job` / `finish_agent_job` / `record_dataset_version`
 * and does no bookkeeping of its own. `agent_jobs` remains the single record of
 * what work exists and what became of it, which is what lets the dashboard's
 * existing two-second poll keep working with no change at all.
 *
 * Replay is handled by the database rather than here. `finish_agent_job`
 * returns a terminal job unchanged -- "a duplicate completion is a retry of the
 * report, not an error" -- so a callback delivered twice is safe even under the
 * `github` signing scheme, which carries no timestamp to bound.
 */

const resultSchema = z.object({
  job_id: z.string().uuid(),
  status: z.enum(['running', 'succeeded', 'failed']),
  progress: z.record(z.string(), z.unknown()).nullish(),
  /**
   * Free-form, and deliberately so: it lands in `agent_jobs.result`, which the
   * download route reads for the filename it shows the customer. The fields it
   * looks for are `export_path`, `dataset_name`, `source_filename` and
   * `version_no`; anything else the agent wants to record travels with them.
   */
  result: z.record(z.string(), z.unknown()).nullish(),
  error: z.string().max(2000).nullish(),
  /**
   * Whether a failure is worth another attempt. Defaults to false: an agent
   * that cannot say usually failed for a reason that will repeat, and burning
   * three attempts on a malformed workbook wastes minutes of a single CPU core
   * to reach the same answer.
   */
  retryable: z.boolean().nullish(),
});

/** Buckets an agent may claim to have written to. Never `raw`. */
const WRITABLE_BUCKETS = new Set(['exports', 'parquet']);

export async function POST(request: Request) {
  // Raw text, not `request.json()`. The signature covers exact bytes, and
  // parsing then re-serialising to verify would reorder keys and drop
  // whitespace -- failing on bodies that are perfectly valid.
  const rawBody = await request.text();

  const signature = verifyCallbackSignature(rawBody, request.headers);
  if (!signature.ok) {
    // Logged with the reason, answered without it. Telling an unauthenticated
    // caller whether the timestamp or the digest failed is telling them how to
    // fix it.
    console.warn(`[hermes] rejected callback: ${signature.reason}`);
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let parsed: z.infer<typeof resultSchema>;
  try {
    parsed = resultSchema.parse(JSON.parse(rawBody));
  } catch {
    return NextResponse.json({ error: 'malformed result payload' }, { status: 400 });
  }

  const admin = createAdminSupabase();

  // The job row is the authority on tenancy. Read it before acting on anything
  // the payload claims.
  const { data: job, error: loadError } = await admin
    .from('agent_jobs')
    .select('id, org_id, workspace_id, dataset_id, dataset_version_id, kind, status, claimed_by')
    .eq('id', parsed.job_id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }

  // A job the agent does not hold is not the agent's to report on. `finish_agent_job`
  // enforces this too, but catching it here turns a database exception into a
  // readable 409 and keeps a stray callback out of the audit trail.
  if (job.claimed_by !== HERMES_WORKER_ID) {
    return NextResponse.json(
      { error: `job is claimed by ${job.claimed_by ?? 'nobody'}` },
      { status: 409 },
    );
  }

  // Progress only. Renews the lease in the same write that reports the stage,
  // so the queue's liveness signal and the dashboard's progress bar can never
  // disagree -- they are the same row.
  if (parsed.status === 'running') {
    const { error } = await admin.rpc('heartbeat_agent_job', {
      p_job_id: job.id,
      p_worker_id: HERMES_WORKER_ID,
      p_progress: (parsed.progress ?? {}) as never,
      p_lease_seconds: JOB_LEASE_SECONDS,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ status: 'ok' });
  }

  if (parsed.status === 'failed') {
    const { error } = await admin.rpc('finish_agent_job', {
      p_job_id: job.id,
      p_worker_id: HERMES_WORKER_ID,
      p_success: false,
      p_error: parsed.error ?? 'the agent reported a failure with no message',
      p_retryable: parsed.retryable ?? false,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ status: 'ok' });
  }

  // Success. Everything below writes; order matters.
  const result = (parsed.result ?? {}) as Record<string, unknown>;

  const bucket = typeof result.bucket === 'string' ? result.bucket : 'exports';
  if (!WRITABLE_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: `results may not come from ${bucket}` }, { status: 400 });
  }

  // The version is recorded before the job is finished. A job marked succeeded
  // whose version write then failed would show the customer a finished run with
  // no lineage behind it -- and `finish_agent_job` is the write the dashboard
  // reacts to, so it has to be last.
  const parquetPath = typeof result.parquet_path === 'string' ? result.parquet_path : null;

  if (parquetPath && job.dataset_id) {
    const { data: version, error: versionError } = await admin.rpc('record_dataset_version', {
      p_dataset_id: job.dataset_id,
      p_kind: 'cleaned',
      p_parquet_path: parquetPath,
      p_row_count: typeof result.row_count === 'number' ? result.row_count : null,
      p_parent_version_id: job.dataset_version_id,
      p_produced_by_job: job.id,
    } as never);

    if (versionError) {
      // Left running, not failed. The work succeeded and the object exists; a
      // bookkeeping failure is worth a retry of the report rather than throwing
      // away a cleaned file the customer is waiting for.
      console.error(`[hermes] could not record version for job ${job.id}: ${versionError.message}`);
      return NextResponse.json({ error: versionError.message }, { status: 500 });
    }

    if (version && typeof version === 'object' && 'version_no' in version) {
      result.version_no = (version as { version_no: unknown }).version_no;
    }
  }

  const { error: finishError } = await admin.rpc('finish_agent_job', {
    p_job_id: job.id,
    p_worker_id: HERMES_WORKER_ID,
    p_success: true,
    p_result: result as never,
  });

  if (finishError) {
    return NextResponse.json({ error: finishError.message }, { status: 409 });
  }

  // The agent proved it is alive by completing something. The dashboard's
  // "Agent online" badge reads this row, and nothing else updates it -- the
  // agent holds no database credentials and cannot heartbeat for itself.
  await admin
    .from('agent_workers')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', HERMES_WORKER_ID);

  return NextResponse.json({ status: 'ok' });
}
