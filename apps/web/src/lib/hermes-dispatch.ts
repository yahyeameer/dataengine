import 'server-only';

import {
  HERMES_WORKER_ID,
  JOB_LEASE_SECONDS,
  SIGNED_URL_TTL_SECONDS,
  callbackUrl,
  dispatchJob,
  hermesConfigured,
  newRequestId,
  type HermesJobPayload,
} from '@/lib/hermes';
import {
  EXPORTS_BUCKET,
  PARQUET_BUCKET,
  RAW_BUCKET,
  buildExportObjectPath,
  buildParquetObjectPath,
  type ExportFormat,
} from '@/lib/storage';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * Handing one job to the agent.
 *
 * `server-only` at the top for the reason the old AnalyzeIt bridge learned the
 * hard way: this module reaches the service-role client and the shared secret,
 * and importing it from a client component should be a build error rather than
 * a silent leak into the browser bundle.
 *
 * The shape of what gets sent is the security design. The agent receives two
 * signed URLs -- one object it may read, one key it may write -- minted here
 * *after* the caller's membership has already been proven, and nothing else. It
 * holds no Supabase credential, so it cannot widen its reach by asking for a
 * different workspace: its reach is a pair of URLs, not a claim it makes.
 *
 * That is the same property the old repo bought with signed scope tokens, and it
 * costs less here because the agent only ever needs two objects.
 */

type DispatchResult =
  | { dispatched: true; requestId: string }
  | { dispatched: false; reason: string };

type JobRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  dataset_id: string | null;
  dataset_version_id: string | null;
  raw_upload_id: string | null;
  kind: string;
  payload: Record<string, unknown> | null;
};

/**
 * Push a queued job to the agent, or mark it failed trying.
 *
 * Never throws. By the time this runs the job row is already committed, and an
 * exception here would return a 500 to a caller whose work was in fact
 * accepted -- leaving a queued row with nothing coming for it, which is the one
 * ending that produces a spinner the customer watches forever. Every failure
 * path below ends with the job in a terminal state carrying a readable message.
 */
export async function dispatchJobToHermes(jobId: string): Promise<DispatchResult> {
  const admin = createAdminSupabase();

  if (!hermesConfigured()) {
    await failJob(jobId, 'The agent is not connected. Set HERMES_WEBHOOK_URL and HERMES_WEBHOOK_SECRET.');
    return { dispatched: false, reason: 'not configured' };
  }

  // Claim first, dispatch second. The claim is what stops a duplicate click
  // from handing the same file to the agent twice -- the second claim finds the
  // row already running on a live lease and returns nothing.
  const { data: claimed, error: claimError } = await admin
    .rpc('claim_agent_job_by_id', {
      p_job_id: jobId,
      p_worker_id: HERMES_WORKER_ID,
      p_lease_seconds: JOB_LEASE_SECONDS,
    })
    .select('id, org_id, workspace_id, dataset_id, dataset_version_id, raw_upload_id, kind, payload')
    .maybeSingle<JobRow>();

  if (claimError) {
    return { dispatched: false, reason: claimError.message };
  }
  if (!claimed) {
    // Already running, already finished, or out of attempts. Not an error: a
    // second click on "Clean" should be a no-op, not a second run.
    return { dispatched: false, reason: 'job was not claimable' };
  }

  const job = claimed;

  let input: HermesJobPayload['input'] = null;
  let output: HermesJobPayload['output'] = null;

  try {
    input = await signInput(admin, job);
    output = await signOutput(admin, job);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : 'could not prepare the file';
    await failJob(jobId, reason);
    return { dispatched: false, reason };
  }

  const requestId = newRequestId();
  const payload: HermesJobPayload = {
    request_id: requestId,
    job_id: job.id,
    kind: job.kind,
    workspace_id: job.workspace_id,
    dataset_id: job.dataset_id,
    dataset_version_id: job.dataset_version_id,
    input,
    output,
    callback_url: callbackUrl(),
    expires_at: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  };

  const outcome = await dispatchJob(payload);

  if (!outcome.ok) {
    const reason =
      outcome.status === 401
        ? 'The agent rejected our signature. The shared secret does not match the one on its webhook route.'
        : `The agent's gateway did not accept the job${
            outcome.status ? ` (${outcome.status})` : ''
          }: ${outcome.detail}`;
    // Not retryable. A signature mismatch or an unreachable gateway will fail
    // identically on the next two attempts, and burning them buys nothing but a
    // slower error on a box with one CPU core.
    await failJob(jobId, reason);
    return { dispatched: false, reason };
  }

  return { dispatched: true, requestId };
}

/**
 * A signed URL for the object the agent must read.
 *
 * Either the workbook exactly as it arrived, or -- for a job that continues
 * from an existing cleaned version -- that version's Parquet. Nothing else is
 * ever offered, and the key is built here rather than taken from a caller.
 */
async function signInput(
  admin: ReturnType<typeof createAdminSupabase>,
  job: JobRow,
): Promise<HermesJobPayload['input']> {
  if (job.raw_upload_id) {
    const { data: upload, error } = await admin
      .from('raw_uploads')
      .select('storage_path, original_filename, byte_size, status')
      .eq('id', job.raw_upload_id)
      .maybeSingle();

    if (error) throw new Error(`could not read the upload: ${error.message}`);
    if (!upload) throw new Error('the upload no longer exists');
    if (upload.status !== 'stored') {
      throw new Error(`the upload is ${upload.status}, not stored; there is nothing to process`);
    }

    const { data: signed, error: signError } = await admin.storage
      .from(RAW_BUCKET)
      .createSignedUrl(upload.storage_path, SIGNED_URL_TTL_SECONDS);

    if (signError || !signed) {
      throw new Error(`could not sign the input file: ${signError?.message ?? 'unknown error'}`);
    }

    return {
      url: signed.signedUrl,
      filename: upload.original_filename,
      byte_size: upload.byte_size,
    };
  }

  if (job.dataset_version_id) {
    const { data: version, error } = await admin
      .from('dataset_versions')
      .select('parquet_path, version_no')
      .eq('id', job.dataset_version_id)
      .maybeSingle();

    if (error) throw new Error(`could not read the dataset version: ${error.message}`);
    if (!version?.parquet_path) {
      throw new Error('that dataset version has no stored data to work from');
    }

    const { data: signed, error: signError } = await admin.storage
      .from(PARQUET_BUCKET)
      .createSignedUrl(version.parquet_path, SIGNED_URL_TTL_SECONDS);

    if (signError || !signed) {
      throw new Error(`could not sign the input file: ${signError?.message ?? 'unknown error'}`);
    }

    return {
      url: signed.signedUrl,
      filename: `v${version.version_no}.parquet`,
      byte_size: null,
    };
  }

  // A job with neither is a question about a workspace, not work on a file.
  // Legitimate for some kinds, so this is null rather than an exception.
  return null;
}

/**
 * Signed upload URLs for what the agent produces.
 *
 * Two of them: the Parquet that becomes the next dataset version, and the
 * xlsx or csv the customer actually downloads. Both keys are computed here, so
 * the agent never chooses where anything lands -- it is handed one key per
 * artefact and can write nowhere else.
 *
 * `createSignedUploadUrl` mints a one-shot token bound to that exact key, which
 * is what makes this safe to hand to a runtime we do not control.
 */
async function signOutput(
  admin: ReturnType<typeof createAdminSupabase>,
  job: JobRow,
): Promise<HermesJobPayload['output']> {
  if (!job.dataset_id) return null;

  const requested = (job.payload?.format as string | undefined)?.toLowerCase();
  const format: ExportFormat = requested === 'csv' ? 'csv' : 'xlsx';

  const exportPath = buildExportObjectPath({
    orgId: job.org_id,
    workspaceId: job.workspace_id,
    datasetId: job.dataset_id,
    jobId: job.id,
    format,
  });

  const parquetPath = buildParquetObjectPath({
    orgId: job.org_id,
    workspaceId: job.workspace_id,
    datasetId: job.dataset_id,
    jobId: job.id,
  });

  const [exportSigned, parquetSigned] = await Promise.all([
    admin.storage.from(EXPORTS_BUCKET).createSignedUploadUrl(exportPath),
    admin.storage.from(PARQUET_BUCKET).createSignedUploadUrl(parquetPath),
  ]);

  if (exportSigned.error || !exportSigned.data) {
    throw new Error(
      `could not sign the output location: ${exportSigned.error?.message ?? 'unknown error'}`,
    );
  }

  return {
    export_url: exportSigned.data.signedUrl,
    export_path: exportPath,
    format,
    // Best effort. A dataset version is lineage, and lineage is worth having;
    // but a job that produces only a downloadable file is still a job that
    // succeeded, so a failure to sign this one does not stop the dispatch.
    ...(parquetSigned.data
      ? { parquet_url: parquetSigned.data.signedUrl, parquet_path: parquetPath }
      : {}),
  };
}

/**
 * Put a job into a terminal failed state with a message a person can act on.
 *
 * `p_retryable: false` throughout. Everything routed here -- a missing file, an
 * unreachable gateway, a rejected signature -- fails the same way on the next
 * attempt, and the queue's retries exist for transient faults rather than
 * misconfiguration.
 */
async function failJob(jobId: string, error: string): Promise<void> {
  const admin = createAdminSupabase();
  const { error: rpcError } = await admin.rpc('finish_agent_job', {
    p_job_id: jobId,
    p_worker_id: HERMES_WORKER_ID,
    p_success: false,
    p_error: error.slice(0, 2000),
    p_retryable: false,
  });

  if (rpcError) {
    // Nothing further to do -- the caller is already handling a failure, and
    // throwing here would replace a readable message with a database one.
    console.error(`[hermes] could not mark job ${jobId} failed: ${rpcError.message}`);
  }
}
