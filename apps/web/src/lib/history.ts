import type { Json } from '@/lib/database.types';
import type { AgentJobKind, AgentJobStatus } from '@/lib/agent';

/**
 * Operation history: what was done to this workspace's data, and how to get
 * back to it.
 *
 * There is no history table and there should not be one. `agent_jobs` already
 * records every operation with the columns the question needs -- org,
 * workspace, dataset, source version, kind, status, requester, timestamps and
 * a result blob -- and the file each one produced is already in the `exports`
 * bucket, reachable through `/api/exports?jobId=`. Every part of "return days
 * later and download it again" was already durable.
 *
 * What was missing was a way back to the job id. The categorise screen holds
 * its run in React state keyed on an upload id, so leaving the page dropped
 * the only reference the customer had to a file that still existed. A second
 * history system would have duplicated rows that are already written; this
 * reads them.
 *
 * Nothing here invents a figure. Every field is either present on the job row
 * or absent from the interface -- see the null returns below.
 */

/**
 * The kinds that are operations on a customer's data, as opposed to the
 * plumbing that carries them.
 *
 * `parse_workbook` and `profile_dataset` are deliberately absent. They run on
 * every upload, they are steps inside somebody else's operation, and listing
 * them turns a history of five things the accountant did into a history of
 * twenty things the machine did.
 */
export const HISTORY_KINDS = [
  'categorise_statement',
  'categorize_dataset',
  'apply_cleaning',
  'propose_cleaning',
  'replay_recipe',
  'query_dataset',
  'reconcile_sources',
  'generate_report',
  'kanban_report',
  'export_dataset',
  'hmrc_knowledge_check',
] as const satisfies readonly AgentJobKind[];

export type HistoryKind = (typeof HISTORY_KINDS)[number];

/**
 * The operation, named as the accountant would name it.
 *
 * Distinct from `JOB_KIND_LABELS` in `lib/agent`, which is written in the
 * present continuous for a job running now ("Categorising for HMRC"). A
 * history entry is a finished thing and reads as a noun.
 */
export const OPERATION_LABELS: Record<HistoryKind, string> = {
  categorise_statement: 'Categorisation',
  categorize_dataset: 'Categorisation',
  apply_cleaning: 'Cleaning applied',
  propose_cleaning: 'Cleaning review',
  replay_recipe: 'Recipe replay',
  query_dataset: 'Analysis',
  reconcile_sources: 'Reconciliation',
  generate_report: 'Report',
  kanban_report: 'Report',
  export_dataset: 'Export',
  hmrc_knowledge_check: 'HMRC guidance check',
};

/**
 * The families the workspace groups history by.
 *
 * The distinction asked for is between categorisation, analysis and reports
 * rather than one undifferentiated timeline, and a family is what makes that a
 * filter instead of a reading exercise.
 */
export type OperationFamily = 'categorisation' | 'cleaning' | 'analysis' | 'report' | 'export';

export const OPERATION_FAMILY: Record<HistoryKind, OperationFamily> = {
  categorise_statement: 'categorisation',
  categorize_dataset: 'categorisation',
  apply_cleaning: 'cleaning',
  propose_cleaning: 'cleaning',
  replay_recipe: 'cleaning',
  query_dataset: 'analysis',
  reconcile_sources: 'analysis',
  generate_report: 'report',
  kanban_report: 'report',
  export_dataset: 'export',
  hmrc_knowledge_check: 'analysis',
};

export const FAMILY_LABELS: Record<OperationFamily, string> = {
  categorisation: 'Categorisation',
  cleaning: 'Cleaning',
  analysis: 'Analysis',
  report: 'Reports',
  export: 'Exports',
};

/** The columns an operation needs. Kept narrow so a page can select exactly these. */
export type HistoryJobRow = {
  id: string;
  kind: AgentJobKind;
  status: AgentJobStatus;
  result: Json;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  dataset_id: string | null;
  dataset_version_id: string | null;
};

export type Operation = {
  id: string;
  kind: HistoryKind;
  label: string;
  family: OperationFamily;
  status: AgentJobStatus;
  createdAt: string;
  finishedAt: string | null;
  /**
   * The timestamps as text, formatted where `toOperation` runs -- on the
   * server. The list that renders them is a client component, so formatting
   * there would produce the server's zone during SSR and the browser's after
   * hydration.
   */
  createdLabel: string;
  finishedLabel: string | null;
  /** The file the customer sent, when the job recorded one. */
  source: string | null;
  datasetId: string | null;
  versionNo: number | null;
  datasetVersionId: string | null;
  /** Present only when the job actually counted them. */
  rows: number | null;
  categorised: number | null;
  flagged: number | null;
  categories: string[] | null;
  byteSize: number | null;
  modelUsed: string | null;
  /** True only when a file is genuinely there to fetch. */
  downloadable: boolean;
  error: string | null;
  /**
   * The job's own result, carried through so a download control can name the
   * file from the real stored path rather than from a reconstruction.
   *
   * It is this workspace's own data and it already crosses to the browser for
   * the live job panel. Nothing here is an authorisation: `/api/exports` reads
   * the row again under the caller's RLS and re-derives the path server-side.
   */
  result: Json;
};

/**
 * The kinds `/api/exports` will sign a URL for.
 *
 * Mirrors `DOWNLOADABLE_KINDS` in that route. Duplicated rather than shared
 * because the route's copy is the one that decides -- this one only decides
 * whether to *offer* the button, and a history list offering a download the
 * route would refuse is worse than one offering none.
 */
const DOWNLOADABLE_KINDS: ReadonlySet<string> = new Set([
  'generate_report',
  'export_dataset',
  'kanban_report',
  'categorise_statement',
]);

const DOWNLOADABLE_BUCKETS: ReadonlySet<string> = new Set(['exports', 'cleaned']);

function record(value: Json): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function isHistoryKind(kind: string): kind is HistoryKind {
  return (HISTORY_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether this job left a file behind that `/api/exports` can still sign.
 *
 * Three conditions, all read off the row: the kind produces artefacts, the job
 * actually succeeded, and the result names a bucket and a path in it. A job
 * that failed halfway through writing its workbook satisfies the first and
 * fails the third, which is the case this exists to catch -- offering a
 * download that 404s is how a customer stops believing the history.
 */
export function isDownloadable(job: { kind: string; status: string; result: Json }): boolean {
  if (!DOWNLOADABLE_KINDS.has(job.kind)) return false;
  if (job.status !== 'succeeded') return false;

  const result = record(job.result);
  const bucket = stringOrNull(result.bucket);
  const path = stringOrNull(result.export_path) ?? stringOrNull(result.report_path);

  return Boolean(bucket && path && DOWNLOADABLE_BUCKETS.has(bucket));
}

/**
 * One job row as an operation.
 *
 * `datasetNames` fills in a source for jobs that recorded none -- an
 * `export_dataset` names the dataset it exported but not the workbook that
 * dataset came from. Returns null for anything that is not a history kind, so
 * a caller can map over every job it fetched.
 */
export function toOperation(
  job: HistoryJobRow,
  datasetNames?: ReadonlyMap<string, string>,
): Operation | null {
  if (!isHistoryKind(job.kind)) return null;

  const result = record(job.result);
  const categories = Array.isArray(result.categories)
    ? result.categories.filter((value): value is string => typeof value === 'string')
    : null;

  return {
    id: job.id,
    kind: job.kind,
    label: OPERATION_LABELS[job.kind],
    family: OPERATION_FAMILY[job.kind],
    status: job.status,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    createdLabel: formatOperationDate(job.created_at),
    finishedLabel: job.finished_at ? formatOperationDate(job.finished_at) : null,
    source:
      stringOrNull(result.source_filename) ??
      stringOrNull(result.dataset_name) ??
      (job.dataset_id ? datasetNames?.get(job.dataset_id) ?? null : null),
    datasetId: job.dataset_id,
    versionNo: numberOrNull(result.version_no),
    datasetVersionId: stringOrNull(result.dataset_version_id) ?? job.dataset_version_id,
    // `rows_total` is what categorise_statement counted in the file it wrote;
    // `row_count` is what export_dataset wrote out. Neither is invented, and a
    // job that counted nothing reports null rather than a confident zero.
    rows: numberOrNull(result.rows_total) ?? numberOrNull(result.row_count),
    categorised: numberOrNull(result.rows_categorised),
    flagged: numberOrNull(result.rows_flagged),
    categories: categories && categories.length > 0 ? categories : null,
    byteSize: numberOrNull(result.byte_size),
    modelUsed: stringOrNull(result.model_used),
    downloadable: isDownloadable(job),
    error: job.error,
    result: job.result,
  };
}

/** Every history-worthy job in the rows given, in the order they were given. */
export function toOperations(
  jobs: HistoryJobRow[],
  datasetNames?: ReadonlyMap<string, string>,
): Operation[] {
  return jobs
    .map((job) => toOperation(job, datasetNames))
    .filter((operation): operation is Operation => operation !== null);
}

/**
 * "31 Aug 2026, 14:32" -- the two facts a history row is scanned for.
 *
 * Absolute rather than relative. `formatAge` is right for a job running now
 * ("2 minutes ago"); an operation somebody is trying to find again months
 * later is looked up by date, and "94d ago" is not a date.
 *
 * London, explicitly, for two reasons that happen to agree. The product maps
 * to HMRC self-assessment boxes and prices in sterling, so the wall clock an
 * accountant reconciles against is the UK one wherever they happen to be
 * sitting. And pinning the zone makes the output a pure function of the
 * timestamp, which is what lets these labels be computed on the server and
 * handed to a client component as strings -- the alternative renders one time
 * in the server's zone and another after hydration, which is a mismatch React
 * is right to complain about.
 */
export function formatOperationDate(timestamp: string): string {
  const at = new Date(timestamp);
  return `${at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/London',
  })}, ${at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  })}`;
}

/** "2,481 rows", or null when the job counted none. */
export function formatRows(rows: number | null): string | null {
  if (rows === null) return null;
  return `${rows.toLocaleString('en-GB')} ${rows === 1 ? 'row' : 'rows'}`;
}

/**
 * The one-word outcome, in the customer's vocabulary rather than the queue's.
 *
 * `succeeded` is what the column says and "Completed" is what the accountant
 * reads; a job still queued should say so rather than borrow the word for
 * running.
 */
export const OPERATION_STATUS_LABELS: Record<AgentJobStatus, string> = {
  queued: 'Queued',
  running: 'Processing',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
