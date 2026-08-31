import type { Database } from '@/lib/database.types';

/**
 * Shared vocabulary for the agent, so the dashboard and the API routes agree
 * on what a job is called and when a worker counts as alive.
 *
 * The agent runs on a host the web app does not manage — a VPS, in the
 * deployment this repo documents — and the only thing the two share is the
 * database. That makes liveness a *derived* fact rather than a reported one:
 * nothing can tell the dashboard "the agent has stopped", because a stopped
 * agent cannot send messages. The dashboard has to infer it from silence.
 */

export type AgentJobKind = Database['public']['Enums']['agent_job_kind'];
export type AgentJobStatus = Database['public']['Enums']['agent_job_status'];
export type ChangeConfidence = Database['public']['Enums']['change_confidence'];

/**
 * A worker heartbeats every 30 seconds. Three missed beats is offline.
 *
 * Deliberately not one: a single missed heartbeat is a slow network or a long
 * database write, and an agent that flickers "offline" every few minutes
 * teaches people to ignore the indicator entirely.
 */
export const WORKER_STALE_AFTER_MS = 90_000;

export function isWorkerOnline(lastSeenAt: string | null | undefined): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < WORKER_STALE_AFTER_MS;
}

/**
 * What the engine is actually doing, in four states rather than two.
 *
 * "Connected or offline" collapsed three different situations into one word.
 * A worker that is running with no model behind it answered from the rule
 * engine and reported *connected*, which is true and useless -- the customer's
 * explanations had quietly got worse and the indicator said everything was
 * fine. A worker whose health probe could not reach the database reported the
 * same thing, on no evidence at all.
 *
 * So:
 *
 * - `connected` — heartbeat fresh, and no job has fallen back to the rule
 *                 engine in the last 24 hours.
 * - `degraded`  — heartbeat fresh, but at least one job in the last 24 hours
 *                 was answered without a model. Note the tense: this is a
 *                 windowed record, not a live reachability probe, so it can be
 *                 true while the model is reachable again. Saying "running
 *                 without a model" in the present tense overstated it.
 * - `offline`   — no worker has heartbeated inside the window. Work queues.
 * - `unknown`   — a worker is alive but could not determine its own health, or
 *                 no worker has ever reported. Not the same claim as healthy,
 *                 and reporting it as such is how a monitor starts lying.
 */
export type EngineState = 'connected' | 'degraded' | 'offline' | 'unknown';

export type EngineWorker = {
  last_seen_at: string;
  metadata?: unknown;
};

export function engineStateFor(workers: EngineWorker[]): EngineState {
  const live = workers.filter((worker) => isWorkerOnline(worker.last_seen_at));
  if (live.length === 0) return workers.length === 0 ? 'unknown' : 'offline';

  // The freshest worker's verdict wins. Several may be alive; the one that
  // reported most recently is the one whose answer is current.
  const [freshest] = [...live].sort(
    (a, b) => new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime(),
  );

  const metadata =
    freshest.metadata && typeof freshest.metadata === 'object' && !Array.isArray(freshest.metadata)
      ? (freshest.metadata as Record<string, unknown>)
      : {};

  const health = metadata.llm_health;

  // A worker old enough to predate the health check reports nothing here. It is
  // alive and claiming jobs, and that is all that can honestly be said.
  if (health === undefined || health === null) return 'unknown';
  if (health === 'degraded') return 'degraded';
  if (health === 'ok') return 'connected';
  return 'unknown';
}

export const ENGINE_STATE_LABELS: Record<EngineState, string> = {
  connected: 'Engine connected',
  degraded: 'Engine degraded',
  offline: 'Engine offline',
  unknown: 'Engine status unknown',
};

/** What the reader should understand follows from each state. */
export const ENGINE_STATE_DETAIL: Record<EngineState, string> = {
  connected: '',
  degraded:
    'At least one job in the last 24 hours was answered by the rule engine rather than the model. Figures are still correct; those explanations are plainer.',
  offline:
    'Nothing will run until it reconnects. Anything you ask for is queued and picked up automatically.',
  unknown:
    'A worker is running but could not report whether the model is reachable. Results may be coming from the rule engine.',
};

export const JOB_KIND_LABELS: Record<AgentJobKind, string> = {
  parse_workbook: 'Reading the workbook',
  profile_dataset: 'Profiling the data',
  propose_cleaning: 'Working out what to fix',
  apply_cleaning: 'Applying approved changes',
  replay_recipe: 'Replaying the saved recipe',
  query_dataset: 'Answering a question',
  reconcile_sources: 'Reconciling two sources',
  generate_report: 'Writing the report',
  export_dataset: 'Preparing the download',
  categorize_dataset: 'Sorting values into categories',
  // Named for what it produces, not for how. "Kanban", "supervisor" and
  // "verifier" are the internal machinery of this one; an accountant is waiting
  // for a report that somebody checked, and that is what the label should say.
  kanban_report: 'Writing and checking the report',
};

/**
 * The tiers of PRD section 5.1, in the words the accountant sees.
 *
 * "Blocks the run" rather than "low confidence": the tier is about consequence,
 * not about how sure the agent is, and naming it after the consequence is what
 * makes the queue sortable by someone who has thirty seconds.
 */
export const CONFIDENCE_LABELS: Record<ChangeConfidence, string> = {
  high: 'Routine',
  medium: 'Needs review',
  low: 'Blocks the run',
};

export const CONFIDENCE_ORDER: ChangeConfidence[] = ['low', 'medium', 'high'];

/**
 * Findings that ask someone to look at something, rather than changes that do
 * something. Approving one records a decision; it moves no data, and the
 * condition it describes is still true afterwards.
 *
 * Mirrors ADVISORY_OPERATIONS in services/hermes/hermes/tools/clean.py, where
 * every one of these dispatches to a no-op. The queue needs the distinction
 * because "apply" is not a thing that can be done to them: an approved set
 * containing only these produces no new version, and offering the button
 * without saying so invites the reviewer to conclude the run failed.
 */
export const ADVISORY_STEP_TYPES: ReadonlySet<string> = new Set([
  'review_ambiguous_dates',
  'review_key_conflicts',
  'review_outliers',
  'review_vat_rate',
  'block_totals_mismatch',
]);

export function isAdvisory(stepType: string): boolean {
  return ADVISORY_STEP_TYPES.has(stepType);
}

export function isTerminal(status: AgentJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** £4,219.00, or an em dash when a change has no monetary weight. */
export function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const amount = typeof value === 'string' ? Number(value) : value;
  if (Number.isNaN(amount)) return '—';
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 2,
  }).format(amount);
}

/** "2 minutes ago" — the only thing anyone wants to know about a job's age. */
export function formatAge(timestamp: string | null | undefined): string {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
