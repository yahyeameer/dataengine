import { NextResponse } from 'next/server';

import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * The health endpoint an uptime check, a load balancer and a person on call all
 * read.
 *
 * Three states rather than two, because "up" and "down" cannot express the
 * failure this system actually has: the web app serving perfectly while no
 * worker has claimed a job for an hour. That is `degraded` — nothing is broken,
 * and nothing is being processed.
 *
 * What it deliberately does not say: hostnames, connection strings, the
 * database's identity, the size of the queue per tenant, or which customer is
 * affected. An unauthenticated endpoint is read by anybody who finds it, so it
 * reports the *shape* of the system's health and nothing about its contents.
 * The one number it does expose — how long the oldest waiting job has waited —
 * is operational rather than commercial, and is the single most useful signal
 * for deciding whether to add a worker.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A worker announces every 30s; four missed beats is a worker nobody can rely on. */
const WORKER_STALE_SECONDS = 120;

/** Long enough that a slow job is not an alarm; short enough to notice a stall. */
const QUEUE_STALL_SECONDS = 900;

type Check = { status: 'healthy' | 'degraded' | 'unhealthy'; detail?: string };

export async function GET() {
  const checks: Record<string, Check> = {};

  let admin: ReturnType<typeof createAdminSupabase>;
  try {
    admin = createAdminSupabase();
  } catch {
    // No service key configured. The app cannot reach the queue at all, and
    // saying so is more useful than a 500 with a stack trace.
    return NextResponse.json(
      { status: 'unhealthy', checks: { config: { status: 'unhealthy' } } },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  // --- database ------------------------------------------------------------
  const startedAt = Date.now();
  const { error: dbError } = await admin
    .from('agent_workers')
    .select('id', { count: 'exact', head: true });
  const dbLatencyMs = Date.now() - startedAt;

  checks.database = dbError
    ? { status: 'unhealthy', detail: 'unreachable' }
    : { status: dbLatencyMs > 2000 ? 'degraded' : 'healthy', detail: `${dbLatencyMs}ms` };

  // --- workers -------------------------------------------------------------
  //
  // Read from the same row the worker writes on every heartbeat, so this and
  // the dashboard banner cannot disagree about who is alive.
  const { data: workers } = await admin
    .from('agent_workers')
    .select('id, last_seen_at')
    .order('last_seen_at', { ascending: false })
    .limit(20);

  const now = Date.now();
  const live = (workers ?? []).filter(
    (worker) => (now - new Date(worker.last_seen_at).getTime()) / 1000 < WORKER_STALE_SECONDS,
  );

  checks.workers =
    live.length > 0
      ? { status: 'healthy', detail: `${live.length} live` }
      : {
          // Not `unhealthy`: the app still serves, uploads still land, and work
          // queues up to be done when a worker returns. Nothing is lost — it is
          // simply not moving.
          status: 'degraded',
          detail: (workers ?? []).length === 0 ? 'none registered' : 'none heartbeating',
        };

  // --- queue ---------------------------------------------------------------
  const { data: depth, error: depthError } = await admin
    .from('agent_queue_depth')
    .select('runnable, running, oldest_wait_seconds')
    .single();

  // Every column of a view is nullable as far as the generated types are
  // concerned, and an aggregate over an empty table really can be null.
  const oldestWait = depth?.oldest_wait_seconds ?? 0;

  if (depthError || !depth) {
    checks.queue = { status: 'degraded', detail: 'not readable' };
  } else if (oldestWait > QUEUE_STALL_SECONDS) {
    checks.queue = {
      status: 'degraded',
      detail: `oldest job waiting ${Math.round(oldestWait / 60)}m`,
    };
  } else {
    checks.queue = {
      status: 'healthy',
      detail: `${depth.runnable ?? 0} waiting, ${depth.running ?? 0} running`,
    };
  }

  // The worst check wins. A system with one unhealthy component is unhealthy,
  // whatever the others say.
  const statuses = Object.values(checks).map((check) => check.status);
  const status = statuses.includes('unhealthy')
    ? 'unhealthy'
    : statuses.includes('degraded')
      ? 'degraded'
      : 'healthy';

  return NextResponse.json(
    { status, checks, checked_at: new Date().toISOString() },
    {
      // 503 for unhealthy so a load balancer or uptime monitor reacts without
      // having to parse the body. `degraded` stays 200: the app is serving, and
      // taking it out of rotation would turn a processing delay into an outage.
      status: status === 'unhealthy' ? 503 : 200,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
