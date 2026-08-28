import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError } from '@/lib/api';
import { adminFor, requireApiUser, requireWorkspaceAccess } from '@/lib/authz';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * Handing back a file the agent produced.
 *
 * The route takes a **job id**, never a storage path. That is the whole
 * security design of it. Signing a URL requires the service-role client, which
 * bypasses RLS completely, so a route that signed a caller-supplied path would
 * be an arbitrary-object reader over every tenant's data wearing an
 * authorization check as decoration. Taking a job id means the path can only
 * ever come from a row the caller is already allowed to read, and the storage
 * layout (`{org_id}/{workspace_id}/...`) stops being load-bearing for access
 * control.
 *
 * Two checks, on purpose, matching PRD section 13's "RLS plus server-side
 * authorization on every path":
 *
 *   1. the job is read through the caller's own RLS-bound client, so the
 *      database decides whether this job is visible at all
 *   2. `requireWorkspaceAccess` re-derives membership from the workspace the
 *      job claims, so the route does not depend on having got step 1 right
 *
 * Only then is the admin client constructed.
 */

const querySchema = z.object({
  jobId: z.string().uuid(),
});

/** The buckets an export may legitimately live in. Never `raw`. */
const DOWNLOADABLE_BUCKETS = new Set(['exports', 'cleaned']);

/** The job kinds that produce a downloadable artefact. */
const DOWNLOADABLE_KINDS = new Set(['generate_report', 'export_dataset']);

/**
 * Sixty seconds. The link is minted in response to a click and handed straight
 * to the browser, so it needs to survive one redirect, not an afternoon in
 * someone's inbox.
 */
const SIGNED_URL_TTL_SECONDS = 60;

/**
 * What the file is called once it reaches the accountant's Downloads folder.
 *
 * Deliberately not the storage key's last segment. That segment is built for
 * the object store, where a name has to stay unique across every dataset in a
 * workspace, so it leads with a uuid --
 * `a8fade1c-a7d4-4d90-bcf4-274c2680dcfe__v1__export.xlsx`. Nobody can pick that
 * out of a folder a week later, and renaming it by hand is the sort of chore
 * this product exists to remove.
 *
 * The storage key stays as it is; only the Content-Disposition changes, which
 * is the header the browser actually reads for the saved name. The worker
 * records dataset_name and version_no on the job result precisely so this can
 * be reconstructed without a second query.
 */
function downloadName(result: Record<string, unknown>, path: string): string {
  const fallback = path.split('/').pop() ?? 'export';

  // The workbook they sent, if we can still trace it -- "Dheddig_Contacts" is
  // what they will look for, not the dataset name someone typed into a form
  // once. Falls back to the dataset name, then to the object key.
  const source = typeof result.source_filename === 'string' ? result.source_filename.trim() : '';
  const dataset = typeof result.dataset_name === 'string' ? result.dataset_name.trim() : '';
  const stem = source ? source.replace(/\.[^.]+$/, '') : dataset;
  if (!stem) return fallback;

  const extension = fallback.includes('.') ? fallback.slice(fallback.lastIndexOf('.') + 1) : 'bin';
  const version = typeof result.version_no === 'number' ? ` v${result.version_no}` : '';
  // Says what happened to it. A file called the same thing as the original,
  // sitting next to the original, is its own kind of accident.
  const marker = result.export_path ? ' (cleaned)' : ' (report)';

  // A dataset is named by a person, so it can contain anything -- quotes and
  // newlines would break the header outright, and path separators are worse.
  const safe =
    stem
      .replace(/[\\/:*?"<>|\r\n]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'export';

  return `${safe}${marker}${version}.${extension}`;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const { jobId } = querySchema.parse({ jobId: url.searchParams.get('jobId') });

    // Establish the caller before looking anything up. Without this the RLS
    // read below returns nothing for a signed-out request and the route answers
    // 404 -- so an expired session tells the user their file does not exist,
    // which sends them looking for a missing export instead of signing back in.
    // 404 is reserved for the case it is meant for: a job that exists but
    // belongs to somebody else.
    await requireApiUser();

    const supabase = await createServerSupabase();

    const { data: job, error } = await supabase
      .from('agent_jobs')
      .select('id, kind, status, result, workspace_id')
      .eq('id', jobId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // A job belonging to another tenant is invisible under RLS and reported as
    // 404 rather than 403, so the API does not confirm that someone else's job
    // id is real.
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const context = await requireWorkspaceAccess(job.workspace_id);

    if (!DOWNLOADABLE_KINDS.has(job.kind)) {
      return NextResponse.json(
        { error: `A ${job.kind} job does not produce a file` },
        { status: 400 },
      );
    }

    if (job.status !== 'succeeded') {
      return NextResponse.json(
        { error: `This job is ${job.status}; there is nothing to download yet` },
        { status: 409 },
      );
    }

    const result = (job.result ?? {}) as Record<string, unknown>;
    const bucket = typeof result.bucket === 'string' ? result.bucket : null;
    // export_dataset writes export_path, generate_report writes report_path.
    const path =
      typeof result.export_path === 'string'
        ? result.export_path
        : typeof result.report_path === 'string'
          ? result.report_path
          : null;

    if (!bucket || !path || !DOWNLOADABLE_BUCKETS.has(bucket)) {
      return NextResponse.json(
        { error: 'This job recorded no downloadable output' },
        { status: 404 },
      );
    }

    const filename = downloadName(result, path);

    const admin = adminFor(context);
    const { data: signed, error: signError } = await admin.storage
      .from(bucket)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS, {
        download: filename,
      });

    if (signError || !signed) {
      return NextResponse.json(
        { error: signError?.message ?? 'Could not create a download link' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      // The same name the signed URL will set on Content-Disposition, not the
      // object key's last segment. Reporting the key here made the response
      // disagree with the file the browser actually saved -- harmless for the
      // download itself, which reads the header, and precisely wrong for
      // anything that shows the user what they are about to get.
      url: signed.signedUrl,
      filename,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
