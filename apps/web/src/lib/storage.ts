/**
 * Object key layout for the raw bucket (PRD section 3):
 *
 *   {org_id}/{workspace_id}/{YYYY-MM}/{upload_id}__{original_filename}
 *
 * Org first, then workspace, because the storage policy reads the tenant
 * straight out of the path and because Week 7's per-client retention and hard
 * deletion (section 13) delete by prefix. The period segment keeps a client's
 * monthly files naturally grouped, which is also how Week 2 will partition
 * Parquet output.
 */

export const RAW_BUCKET = 'raw';

/**
 * Derived objects. Both are private, both follow the same `{org}/{workspace}/`
 * opening as `raw` -- the storage policy reads the tenant out of the first two
 * segments, so a derived object shaped any other way would be unreadable by the
 * very users who own it.
 *
 * `parquet` holds cleaned dataset versions, which are machine-read.
 * `exports` holds the file a person opens, and is the only bucket the download
 * route will serve from.
 */
export const PARQUET_BUCKET = 'parquet';
export const EXPORTS_BUCKET = 'exports';

/** Formats a cleaned dataset can be handed back in. */
export const EXPORT_FORMATS = ['xlsx', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

/**
 * 25 MB, and the number is measured rather than chosen.
 *
 * The `raw` bucket still accepts 50 MB — a stored file is cheap and the limit
 * there is about storage. This is the limit on what the agent can *process*,
 * and it is lower because parsing holds the whole table in memory: on the
 * current build a CSV costs roughly 21 MB of RSS and 2.8 seconds of CPU per MB
 * of file, against a worker container capped at 768 MB and 0.35 of a core.
 * A 50 MB upload is two incidents at once — it exhausts the container's memory,
 * and its work outlasts the 300-second lease, so a second worker starts parsing
 * the same file while the first is still on it.
 *
 * Refusing here means a person is told before they wait for the upload rather
 * than after. The worker refuses the same size independently
 * (HERMES_MAX_PROCESS_BYTES), because this check is a courtesy and that one is
 * the guarantee.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = ['.xlsx', '.xls', '.csv'] as const;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
};

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export function isAcceptedFilename(filename: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(filename));
}

export function mimeForFilename(filename: string): string {
  return MIME_BY_EXTENSION[extensionOf(filename)] ?? 'application/octet-stream';
}

/**
 * Storage keys are a restricted character set, and a customer filename is
 * arbitrary text -- "ACME Ltd — Sales (final) v2.xlsx" is a realistic example.
 * Sanitise for the key but keep the original verbatim in raw_uploads, because
 * that is what the accountant recognises in the UI.
 */
export function sanitizeFilename(filename: string): string {
  const ext = extensionOf(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;

  const safeStem =
    stem
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'upload';

  return `${safeStem}${ext}`;
}

/** Current reporting period as YYYY-MM, in UTC to stay stable across hosts. */
export function periodSegment(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function buildRawObjectPath(params: {
  orgId: string;
  workspaceId: string;
  uploadId: string;
  filename: string;
  date?: Date;
}): string {
  const { orgId, workspaceId, uploadId, filename, date } = params;
  return [
    orgId,
    workspaceId,
    periodSegment(date),
    `${uploadId}__${sanitizeFilename(filename)}`,
  ].join('/');
}

/**
 * Where a cleaned dataset version's Parquet goes.
 *
 * Keyed by **job id**, not by version number, and that is not an aesthetic
 * choice. The version number is allocated inside the transaction that records
 * the version, which happens *after* the object has to exist -- so naming the
 * object by a predicted number is a guess, and two uploads into the same
 * dataset would guess the same number and silently overwrite each other's data.
 * The job id is already unique and already known before anything is written.
 *
 * Ported from `_parquet_path` in services/hermes/hermes/jobs.py so that objects
 * written by the agent and objects written by the old worker land in the same
 * place and remain mutually readable.
 */
export function buildParquetObjectPath(params: {
  orgId: string;
  workspaceId: string;
  datasetId: string;
  jobId: string;
}): string {
  const { orgId, workspaceId, datasetId, jobId } = params;
  return [orgId, workspaceId, datasetId, `${jobId}.parquet`].join('/');
}

/**
 * Where the file the customer actually downloads goes.
 *
 * Mirrors the layout `handle_export_dataset` writes, with one deliberate
 * difference: the job id is in the key rather than the version number. The
 * Python worker could use the version number because it had already recorded
 * the version by the time it exported; here the export is produced by the same
 * job that produces the version, so the number is not known yet.
 *
 * The key is not what the customer sees. The download route rebuilds a readable
 * filename from the job result and sets it as Content-Disposition, so this only
 * has to be unique and tenant-scoped.
 */
export function buildExportObjectPath(params: {
  orgId: string;
  workspaceId: string;
  datasetId: string;
  jobId: string;
  format: ExportFormat;
  date?: Date;
}): string {
  const { orgId, workspaceId, datasetId, jobId, format, date } = params;
  return [
    orgId,
    workspaceId,
    periodSegment(date),
    `${datasetId}__${jobId}__export.${format}`,
  ].join('/');
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
