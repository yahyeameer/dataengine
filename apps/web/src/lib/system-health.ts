/**
 * Is the model actually running?
 *
 * Every model call degrades to the rule engine on a timeout, an unreachable
 * endpoint, malformed JSON or a missing key. The job still succeeds and
 * proposals still appear -- the only symptom is that the explanations get
 * plainer. The worker already detects that and writes its verdict into
 * `agent_workers.metadata` on every heartbeat.
 *
 * This reads that verdict rather than recomputing it. Two reasons, and the
 * second is the important one:
 *
 * The worker's verdict is already windowed -- it reports degradation seen in
 * the last twenty-four hours, so a fault fixed yesterday stops shouting on its
 * own. Recomputing here would mean a second copy of that window, and two copies
 * of a rule is one rule and one bug waiting to disagree with it.
 *
 * And `agent_llm_health` is granted to service_role alone on purpose: a
 * per-tenant fallback count is not something a customer needs. Reading the
 * worker's summary keeps the aggregate view where it belongs.
 */

export type HealthState = 'ok' | 'degraded' | 'unknown';

export type SystemHealth = {
  state: HealthState;
  /** Job kinds answering without a model, and how many. Empty unless degraded. */
  degradedKinds: Record<string, number>;
  /** When the oldest still-counted degradation happened. */
  degradedSince: string | null;
  /** Which worker reported this, and how long ago. */
  workerId: string | null;
  secondsSinceHeartbeat: number | null;
  /** Why the state is `unknown`, for the operator reading it. */
  reason: string | null;
};

/**
 * A worker that stopped heartbeating cannot vouch for anything.
 *
 * It announces every thirty seconds, so two minutes is four missed beats --
 * long enough that a slow poll or a restart does not raise a false alarm, short
 * enough that a dead worker is noticed while somebody is still at their desk.
 */
const STALE_HEARTBEAT_SECONDS = 120;

type WorkerRow = {
  id: string;
  last_seen_at: string;
  metadata: Record<string, unknown> | null;
};

/**
 * Map a worker row onto a verdict.
 *
 * Pure and exported so it can be tested without a database: the states that
 * matter are the ones that are awkward to produce on demand -- no worker at
 * all, a worker that went quiet, a worker whose own check could not run.
 */
export function readHealth(workers: WorkerRow[], now: Date = new Date()): SystemHealth {
  const empty: SystemHealth = {
    state: 'unknown',
    degradedKinds: {},
    degradedSince: null,
    workerId: null,
    secondsSinceHeartbeat: null,
    reason: null,
  };

  if (workers.length === 0) {
    return { ...empty, reason: 'No worker has ever registered.' };
  }

  // Freshest first: with more than one worker, the one that reported most
  // recently is the one whose verdict is worth anything.
  const worker = [...workers].sort(
    (a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at),
  )[0];

  const age = Math.round((now.getTime() - Date.parse(worker.last_seen_at)) / 1000);
  const base = { workerId: worker.id, secondsSinceHeartbeat: age };

  if (!Number.isFinite(age)) {
    return { ...empty, ...base, secondsSinceHeartbeat: null, reason: 'Worker heartbeat is unreadable.' };
  }

  if (age > STALE_HEARTBEAT_SECONDS) {
    // Deliberately not `degraded`. The model may be fine; what is broken is our
    // ability to say so, and reporting a guess as a finding is how monitoring
    // loses the reader's trust.
    return {
      ...empty,
      ...base,
      reason: `Worker ${worker.id} has not reported for ${age}s.`,
    };
  }

  const metadata = worker.metadata ?? {};
  const reported = metadata.llm_health;

  if (reported === 'ok') {
    return { ...empty, ...base, state: 'ok' };
  }

  if (reported === 'degraded') {
    const kinds = metadata.llm_degraded_kinds;
    return {
      ...empty,
      ...base,
      state: 'degraded',
      degradedKinds:
        kinds && typeof kinds === 'object' ? (kinds as Record<string, number>) : {},
      degradedSince:
        typeof metadata.llm_degraded_since === 'string' ? metadata.llm_degraded_since : null,
    };
  }

  // Includes the worker's own `unknown`, which it reports when its check could
  // not run -- an unreachable database is not the same claim as a healthy one.
  return {
    ...empty,
    ...base,
    reason:
      typeof metadata.llm_health_error === 'string'
        ? `Worker could not check: ${metadata.llm_health_error}.`
        : 'Worker has not reported a health verdict yet.',
  };
}

/**
 * Read the current verdict.
 *
 * Never throws. A banner that can break the page it warns on is worse than no
 * banner -- this renders in the app shell, so an exception here would take
 * every signed-in page down with it.
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  try {
    // Imported here rather than at module scope so `readHealth` above stays
    // importable without dragging in the server-only Supabase client -- which
    // is what lets the mapping be tested from a plain script.
    const { createAdminSupabase } = await import('@/lib/supabase/server');
    const admin = createAdminSupabase();
    const { data, error } = await admin
      .from('agent_workers')
      .select('id, last_seen_at, metadata')
      .order('last_seen_at', { ascending: false })
      .limit(5);

    if (error) {
      return {
        state: 'unknown',
        degradedKinds: {},
        degradedSince: null,
        workerId: null,
        secondsSinceHeartbeat: null,
        reason: 'Could not read worker status.',
      };
    }

    return readHealth((data ?? []) as WorkerRow[]);
  } catch {
    return {
      state: 'unknown',
      degradedKinds: {},
      degradedSince: null,
      workerId: null,
      secondsSinceHeartbeat: null,
      reason: 'Could not read worker status.',
    };
  }
}
