-- =============================================================================
-- Queue hardening: the three things `agent_jobs` could not do.
--
-- The queue was already sound in the ways that are hardest to retrofit --
-- atomic claiming under `for update skip locked`, a lease that reclaims a dead
-- worker's job, a guard that stops a worker writing to a job whose lease was
-- stolen. None of that is touched here.
--
-- What it could not do:
--
--   1. End a job whose worker keeps dying. A job that reaches its attempt
--      ceiling *while running* is left `status = 'running'` with an expired
--      lease. `claim_agent_job` skips it (attempts >= max_attempts) and nothing
--      else looks at it, so it sits there forever: not claimable, not finished,
--      no `finished_at`, and on screen indistinguishable from work in progress.
--
--   2. Wait before retrying. `finish_agent_job` puts a retryable failure back as
--      `queued` with `available_at` untouched, so the next poll claims it
--      immediately. Three attempts against a service that is down are spent in
--      under a second, and the job is marked failed while the outage is still
--      in its first minute.
--
--   3. Stop one tenant taking every worker. The only limit was 30 jobs per user
--      per five minutes, which is a limit on *queueing*, not on running. Thirty
--      queued parses from one firm occupy every worker there is until they are
--      done.
--
-- All three are fixed in the queue itself rather than in the worker, because
-- the worker is the part there are several of.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Limits, as functions rather than constants.
--
-- Same pattern the rate limits already use: a function per number, so an
-- operator changes one with a `create or replace` and no deploy, and so the
-- value is never buried in the middle of a query somebody has to read to find
-- it. Per-organization overrides live in the table below.
-- -----------------------------------------------------------------------------

create or replace function queue_global_concurrency()
returns integer language sql immutable set search_path = public, pg_temp
as $fn$ select 20 $fn$;

create or replace function queue_org_concurrency()
returns integer language sql immutable set search_path = public, pg_temp
as $fn$ select 3 $fn$;

-- The backoff between attempts, in seconds: 30, then 120, then 480. Bounded so
-- a long-running outage does not push a job's next attempt past the point
-- anybody is still waiting for it.
create or replace function queue_retry_backoff_seconds(p_attempt integer)
returns integer language sql immutable set search_path = public, pg_temp
as $fn$
  select least(30 * power(4, greatest(coalesce(p_attempt, 1) - 1, 0)), 900)::integer
$fn$;

-- -----------------------------------------------------------------------------
-- Per-organization limits.
--
-- One row per organization, every column nullable, null meaning "use the
-- default". That shape is the point: quotas can be added as columns and
-- enforced one at a time without touching the execution path, which is what
-- section 26 asks for -- an architecture that admits quotas rather than a
-- billing system nobody has asked for yet.
--
-- Only `max_concurrent_jobs` is enforced today. The others are recorded so the
-- limit exists in one place when the code that reads it is written, and so an
-- operator can already raise a specific customer's ceiling.
-- -----------------------------------------------------------------------------

create table organization_limits (
  organization_id       uuid primary key references organizations (id) on delete cascade,

  -- Enforced, in claim_agent_job below.
  max_concurrent_jobs   integer check (max_concurrent_jobs between 1 and 200),

  -- Recorded, not yet enforced. Each needs a decision about what happens when
  -- it is reached, and a limit that silently does nothing is worse than none.
  max_schedules         integer check (max_schedules between 0 and 1000),
  max_jobs_per_month    integer check (max_jobs_per_month between 0 and 1000000),
  max_upload_bytes      bigint  check (max_upload_bytes between 0 and 5368709120),
  max_storage_bytes     bigint  check (max_storage_bytes >= 0),

  note                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table organization_limits is
  'Per-organization ceilings. Null means the deployment default. Only max_concurrent_jobs is enforced today; the rest are the slots the quota system will read.';

create or replace function org_concurrency_limit(p_org_id uuid)
returns integer
language sql
stable
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select l.max_concurrent_jobs from organization_limits l where l.organization_id = p_org_id),
    queue_org_concurrency()
  )
$fn$;

grant execute on function org_concurrency_limit(uuid) to authenticated, service_role;

-- Counting one organization's live work is now on the hot path of every claim,
-- so it gets an index. Partial and tiny: only running rows are in it, and a
-- healthy queue has a handful.
create index if not exists agent_jobs_running_org_idx
  on agent_jobs (org_id)
  where status = 'running';

-- -----------------------------------------------------------------------------
-- Claiming, with the two ceilings.
--
-- Reproduced whole rather than patched, following the convention this file's
-- neighbours set: a partial redefinition of a SECURITY DEFINER function is how
-- an authorization check gets lost. Everything except the two `and` clauses in
-- the candidate query is byte-for-byte the previous version.
--
-- Both ceilings count only jobs whose lease is still *live*. A job held by a
-- worker that died must not consume its organization's quota -- that would let
-- one crash lock a tenant out of the queue until a sweep ran.
-- -----------------------------------------------------------------------------

create or replace function claim_agent_job(
  p_worker_id      text,
  p_kinds          agent_job_kind[] default null,
  p_lease_seconds  integer default 300
)
returns setof agent_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job    agent_jobs;
  v_live   integer;
begin
  -- The global ceiling, read once. Checked before the candidate query rather
  -- than inside it so a saturated queue costs one cheap count instead of a
  -- correlated subquery per candidate row.
  select count(*) into v_live
    from agent_jobs
   where status = 'running' and lease_expires_at > now();

  if v_live >= queue_global_concurrency() then
    return;
  end if;

  with candidate as (
    select j.id
    from agent_jobs j
    where (
            (j.status = 'queued' and j.available_at <= now())
            or (j.status = 'running' and j.lease_expires_at < now())
          )
      and j.attempts < j.max_attempts
      and (p_kinds is null or j.kind = any (p_kinds))
      -- One organization may not hold more than its share of the workers.
      -- Counted live, so a dead worker's claim does not count against the
      -- tenant it belonged to.
      and (
        select count(*)
          from agent_jobs running
         where running.org_id = j.org_id
           and running.status = 'running'
           and running.lease_expires_at > now()
      ) < org_concurrency_limit(j.org_id)
    order by j.priority, j.created_at
    limit 1
    for update skip locked
  )
  update agent_jobs j
     set status           = 'running',
         claimed_by       = p_worker_id,
         claimed_at       = now(),
         lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
         attempts         = j.attempts + 1,
         started_at       = coalesce(j.started_at, now()),
         error            = null
    from candidate c
   where j.id = c.id
  returning j.* into v_job;

  if not found then
    return;
  end if;

  update agent_workers
     set jobs_claimed = jobs_claimed + 1,
         last_seen_at = now()
   where id = p_worker_id;

  return next v_job;
end;
$fn$;

revoke all on function claim_agent_job(text, agent_job_kind[], integer)
  from public, anon, authenticated;
grant execute on function claim_agent_job(text, agent_job_kind[], integer) to service_role;

-- -----------------------------------------------------------------------------
-- Finishing, with backoff between attempts.
--
-- Again reproduced whole; the only change is the `available_at` assignment in
-- the retry branch. A failure that is worth retrying is nearly always a failure
-- of something that is briefly unavailable, and the useful thing to do about a
-- brief unavailability is to wait.
-- -----------------------------------------------------------------------------

create or replace function finish_agent_job(
  p_job_id    uuid,
  p_worker_id text,
  p_success   boolean,
  p_result    jsonb default null,
  p_error     text default null,
  p_retryable boolean default true
)
returns agent_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job    agent_jobs;
  v_retry  boolean;
begin
  select * into v_job from agent_jobs where id = p_job_id for update;

  if not found then
    raise exception 'job % not found', p_job_id;
  end if;

  if v_job.claimed_by is distinct from p_worker_id then
    raise exception 'job % is claimed by %, not %', p_job_id, v_job.claimed_by, p_worker_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_job.status <> 'running' then
    -- Already terminal. A duplicate completion is a retry of the report, not an
    -- error; return the row unchanged rather than corrupting a finished job.
    return v_job;
  end if;

  v_retry := (not p_success) and coalesce(p_retryable, true)
             and v_job.attempts < v_job.max_attempts;

  update agent_jobs
     set status           = case
                              when p_success then 'succeeded'::agent_job_status
                              when v_retry   then 'queued'::agent_job_status
                              else 'failed'::agent_job_status
                            end,
         result           = coalesce(p_result, result),
         error            = case when p_success then null else p_error end,
         finished_at      = case when p_success or not v_retry then now() else null end,
         claimed_by       = case when v_retry then null else claimed_by end,
         lease_expires_at = null,
         -- Wait before the next attempt. Without this the retry is claimable on
         -- the next poll, and three attempts against a service that is down are
         -- spent inside a second.
         available_at     = case
                              when v_retry
                              then now() + make_interval(
                                     secs => queue_retry_backoff_seconds(v_job.attempts))
                              else available_at
                            end
   where id = p_job_id
  returning * into v_job;

  perform write_audit(
    v_job.org_id, v_job.workspace_id,
    case when p_success then 'agent.job.succeeded'
         when v_retry   then 'agent.job.retrying'
         else                'agent.job.failed' end,
    'agent_job', v_job.id::text,
    jsonb_build_object('kind', v_job.kind, 'worker', p_worker_id,
                       'attempt', v_job.attempts, 'error', p_error,
                       'retry_after', case when v_retry
                         then queue_retry_backoff_seconds(v_job.attempts) end)
  );

  return v_job;
end;
$fn$;

revoke all on function finish_agent_job(uuid, text, boolean, jsonb, text, boolean)
  from public, anon, authenticated;
grant execute on function finish_agent_job(uuid, text, boolean, jsonb, text, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- The sweep: ending jobs nobody will ever finish.
--
-- Two shapes, and they are different failures:
--
--   * `running`, lease expired, attempts exhausted. A worker died on the job's
--     last attempt. Nothing can claim it again, so it is over -- it simply has
--     no row saying so. This is the "running forever" state, and it was
--     reachable before this function existed.
--
--   * `running`, lease expired long ago, attempts remaining. Reclaimable, and
--     `claim_agent_job` will reclaim it. Left alone deliberately: sweeping it
--     would take work away from a worker that was about to do it.
--
-- Called from the worker's idle pass, so it needs no scheduler of its own, and
-- it is safe to run from several workers at once -- the `for update skip
-- locked` means two sweeps divide the work rather than fighting over it.
-- -----------------------------------------------------------------------------

create or replace function sweep_stuck_agent_jobs(p_limit integer default 20)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job   agent_jobs;
  v_count integer := 0;
begin
  for v_job in
    select *
      from agent_jobs
     where status = 'running'
       and lease_expires_at is not null
       and lease_expires_at < now()
       and attempts >= max_attempts
     order by lease_expires_at
     limit greatest(coalesce(p_limit, 20), 1)
     for update skip locked
  loop
    update agent_jobs
       set status      = 'failed',
           finished_at = now(),
           claimed_by  = null,
           lease_expires_at = null,
           error = coalesce(
             error,
             'The agent stopped without reporting a result, on the last of '
             || max_attempts || ' attempts. Run it again once the cause is understood.'
           )
     where id = v_job.id;

    perform write_audit(
      v_job.org_id, v_job.workspace_id, 'agent.job.abandoned', 'agent_job', v_job.id::text,
      jsonb_build_object('kind', v_job.kind, 'attempts', v_job.attempts,
                         'last_worker', v_job.claimed_by,
                         'lease_expired_at', v_job.lease_expires_at)
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$fn$;

revoke all on function sweep_stuck_agent_jobs(integer) from public, anon, authenticated;
grant execute on function sweep_stuck_agent_jobs(integer) to service_role;

-- The sweep's own index: expired leases, newest last. Partial, so it holds only
-- the rows that are candidates rather than every job ever run.
create index if not exists agent_jobs_stuck_idx
  on agent_jobs (lease_expires_at)
  where status = 'running';

-- -----------------------------------------------------------------------------
-- Queue depth, for the health endpoint and for an operator at a SQL prompt.
--
-- A view rather than a function so it can be read with a plain select, and
-- restricted to service_role because queue depth across every tenant is an
-- operator's number, not a customer's.
-- -----------------------------------------------------------------------------

create or replace view agent_queue_depth as
  select
    count(*) filter (where status = 'queued' and available_at <= now())          as runnable,
    count(*) filter (where status = 'queued' and available_at > now())           as waiting,
    count(*) filter (where status = 'running' and lease_expires_at > now())      as running,
    count(*) filter (where status = 'running' and lease_expires_at <= now())     as expired,
    count(*) filter (where status = 'failed' and finished_at > now() - interval '1 hour')
                                                                                 as failed_last_hour,
    count(*) filter (where status = 'succeeded' and finished_at > now() - interval '1 hour')
                                                                                 as succeeded_last_hour,
    -- How long the oldest runnable job has been waiting. The one number that
    -- says "add a worker" on its own.
    coalesce(
      extract(epoch from (now() - min(created_at) filter (
        where status = 'queued' and available_at <= now()
      )))::integer,
      0
    )                                                                            as oldest_wait_seconds
  from agent_jobs;

revoke all on agent_queue_depth from public, anon, authenticated;
grant select on agent_queue_depth to service_role;

alter table organization_limits enable row level security;

-- Members read their own ceilings so the app can show them; nobody edits them
-- from a session. Raising a customer's limit is an operator action.
create policy organization_limits_select_members
  on organization_limits for select to authenticated
  using (is_org_member(organization_id));

grant select on organization_limits to authenticated;
grant all on organization_limits to service_role;
