-- =============================================================================
-- The customer -> Kanban bridge.
--
-- Kanban is a durable SQLite board inside the agent container. It has no RLS,
-- no org_id and no notion of a customer; its `tenant` field is a namespace
-- string. None of that changes here. What changes is that a *trusted* process
-- -- the Python worker, the one component outside the web server holding the
-- service key -- may now drive a Kanban chain on a customer's behalf and carry
-- the verified result back into `agent_jobs`.
--
-- The shape of that is one row per job in `kanban_runs`, and three rules:
--
--   1. `agent_jobs` stays the queue, the lease and the audit trail. A customer
--      waits on a job row, never on a card.
--   2. Exactly one Kanban run may exist per job. `job_id` is unique, so a
--      restarted worker, a duplicate claim and a retried bridge invocation all
--      converge on the same row instead of starting a second chain.
--   3. The correlation id is minted here, by the database, from
--      `gen_random_bytes`. The worker never chooses it and Kanban never sees a
--      Supabase identifier it could guess its way to -- the token is the only
--      thing that maps a returning artefact back to a job, so it has to be
--      unguessable and it has to be issued exactly once.
--
-- A Kanban chain outlives a worker's attention span: four Opus turns at
-- `max_in_progress: 1` is minutes, and a card blocked for missing input is
-- hours. So the bridge does not sit in a loop holding the queue's only worker.
-- It takes one step per claim and hands the job back with `defer_agent_job`,
-- which is the other half of this migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Deferral: a job that is waiting on something slow, without burning an attempt.
--
-- `available_at` defaults to now(), so every existing row and every future
-- enqueue behaves exactly as before. The claim query gains one predicate; the
-- ordering, the lease reclaim and the attempt ceiling are unchanged.
-- -----------------------------------------------------------------------------

alter table agent_jobs
  add column if not exists available_at timestamptz not null default now();

comment on column agent_jobs.available_at is
  'Not claimable before this instant. Set by defer_agent_job so a job waiting on a long external run (a Kanban chain) yields the worker instead of holding it.';

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
  v_job agent_jobs;
begin
  with candidate as (
    select j.id
    from agent_jobs j
    where (
            -- The only change from the original: a deferred job is queued but
            -- not yet runnable. Everything else here is as it was.
            (j.status = 'queued' and j.available_at <= now())
            or (j.status = 'running' and j.lease_expires_at < now())
          )
      and j.attempts < j.max_attempts
      and (p_kinds is null or j.kind = any (p_kinds))
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

-- A deferral is not an attempt.
--
-- `claim_agent_job` increments `attempts` on the way in, which is right for
-- work that ran and wrong for work that looked at a board and decided to come
-- back in thirty seconds. Left alone, a chain that takes ten minutes would
-- exhaust a three-attempt budget in ninety seconds and be marked failed while
-- it was running perfectly. So the counter is given back, and the thing that
-- actually bounds a bridged job is its deadline, recorded on the run.
--
-- No audit row. This fires on every poll of every bridged job; writing one
-- would bury the transitions that matter under thousands that do not. The
-- state changes worth auditing are recorded by kanban_run_advance, which fires
-- only when the phase actually moves.
create or replace function defer_agent_job(
  p_job_id        uuid,
  p_worker_id     text,
  p_progress      jsonb default null,
  p_delay_seconds integer default 30
)
returns agent_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job agent_jobs;
begin
  select * into v_job from agent_jobs where id = p_job_id for update;

  if not found then
    raise exception 'job % not found', p_job_id;
  end if;

  -- Same guard as finish_agent_job, for the same reason: a worker whose lease
  -- lapsed and was stolen must not be able to reach back into a job somebody
  -- else now owns.
  if v_job.claimed_by is distinct from p_worker_id then
    raise exception 'job % is claimed by %, not %', p_job_id, v_job.claimed_by, p_worker_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_job.status <> 'running' then
    -- Already terminal, or already handed back. Returning it unchanged makes a
    -- duplicate deferral a no-op rather than a resurrection.
    return v_job;
  end if;

  update agent_jobs
     set status           = 'queued',
         claimed_by       = null,
         claimed_at       = null,
         lease_expires_at = null,
         available_at     = now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 30), 1)),
         attempts         = greatest(attempts - 1, 0),
         progress         = coalesce(p_progress, progress),
         error            = null
   where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$fn$;

revoke all on function defer_agent_job(uuid, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function defer_agent_job(uuid, text, jsonb, integer) to service_role;

-- -----------------------------------------------------------------------------
-- The bridge's own lifecycle.
--
-- `agent_jobs.status` keeps its five values, because they are what the whole
-- product -- the dashboard, the download route, the audit view -- already means
-- by queued, running, succeeded, failed and cancelled. Widening that enum would
-- change the meaning of every one of those readers to describe a state only one
-- job kind can ever be in.
--
-- The finer lifecycle lives here instead, and is mirrored into
-- `agent_jobs.progress->>'stage'`, which the dashboard already renders
-- verbatim. So the customer sees "orchestrating", "verifying" or "blocked"
-- without a schema change reaching any existing query.
--
--   queued -> claimed -> orchestrating -> running -> verifying -> completed
--
-- with blocked (recoverable: a card is waiting for a person), failed (terminal,
-- and what a verifier FAIL becomes), cancelled and timeout.
-- -----------------------------------------------------------------------------

create type kanban_run_phase as enum (
  'queued',
  'claimed',
  'orchestrating',
  'running',
  'verifying',
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'timeout'
);

create table kanban_runs (
  id                uuid primary key default gen_random_uuid(),

  -- The idempotency key of the whole bridge. One job, one chain, forever.
  job_id            uuid not null unique references agent_jobs (id) on delete cascade,
  org_id            uuid not null references organizations (id) on delete cascade,
  workspace_id      uuid not null references workspaces (id) on delete cascade,

  -- 32 random bytes, hex. Written into every card this run creates and required
  -- back on the returning artefact. Unguessable because it is the only thing
  -- standing between "a result arrived" and "a result arrived for this job" --
  -- Kanban has no tenancy of its own to check.
  correlation_id    text not null unique
                    check (correlation_id ~ '^[0-9a-f]{64}$'),

  board             text not null check (length(btrim(board)) between 1 and 64),
  -- One Kanban tenant per job, and `tenant` is a real namespace on that side:
  -- `kanban list --tenant <name>` returns exactly this job's cards on a board
  -- shared with operator work. Not a shared "customer data" namespace -- one
  -- per job -- and not the same thing as a Kanban *workspace*, which selects
  -- the kind of working directory a card gets (scratch, by default, which
  -- gives every card its own).
  kanban_tenant     text not null check (length(btrim(kanban_tenant)) between 1 and 128),

  root_task_id      text,
  verifier_task_id  text,
  task_ids          text[] not null default '{}',

  phase             kanban_run_phase not null default 'queued',
  -- PASS / FAIL, read off the verifier's run metadata or its block reason. Null
  -- until the verifier has spoken. A `completed` phase with a verdict that is
  -- not PASS is a contradiction, and the check below makes it unwritable.
  verdict           text check (verdict is null or verdict in ('PASS', 'FAIL')),

  blocked_reason    text,
  error             text,
  result            jsonb,

  polls             integer not null default 0 check (polls >= 0),
  last_polled_at    timestamptz,
  deadline_at       timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  finished_at       timestamptz,

  constraint kanban_runs_verdict_ck check (
    phase <> 'completed' or verdict = 'PASS'
  ),
  constraint kanban_runs_terminal_ck check (
    (phase in ('completed', 'failed', 'cancelled', 'timeout') and finished_at is not null)
    or (phase not in ('completed', 'failed', 'cancelled', 'timeout') and finished_at is null)
  )
);

create index kanban_runs_open_idx on kanban_runs (deadline_at)
  where phase not in ('completed', 'failed', 'cancelled', 'timeout');
create index kanban_runs_workspace_idx on kanban_runs (workspace_id, created_at desc);

-- RLS on, and no policy for `authenticated`.
--
-- Deliberate. Nothing here is needed by the dashboard, which reads the phase off
-- `agent_jobs.progress`. The correlation id is a capability -- the token that
-- makes an artefact acceptable -- so the smallest possible set of readers is the
-- right one. If a UI ever needs this, add a view without correlation_id rather
-- than a policy on the table.
alter table kanban_runs enable row level security;
grant all on kanban_runs to service_role;

-- =============================================================================
-- The three calls the worker makes. Nothing else may write this table.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Start, or recover.
--
-- Called at the top of every bridged job, every time it is claimed. The first
-- call mints the run; every subsequent one returns the same row. That is the
-- whole of the bridge's idempotency, and it is `on conflict do nothing` rather
-- than a read-then-write because two workers racing a stolen lease must not be
-- able to produce two correlation ids for one job.
-- -----------------------------------------------------------------------------

create or replace function kanban_run_start(
  p_job_id           uuid,
  p_worker_id        text,
  p_board            text,
  p_deadline_seconds integer default 3600
)
returns kanban_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job     agent_jobs;
  v_run     kanban_runs;
  v_created boolean := false;
begin
  select * into v_job from agent_jobs where id = p_job_id for update;

  if not found then
    raise exception 'job % not found', p_job_id;
  end if;

  -- The authorisation of the whole bridge, in two lines. Only a job that is
  -- running, and only the worker actually holding it, may start or touch a
  -- Kanban run. A customer cannot reach this function at all -- it is granted
  -- to service_role alone -- and a worker whose lease lapsed cannot reach a run
  -- somebody else has taken over.
  if v_job.status <> 'running' or v_job.claimed_by is distinct from p_worker_id then
    raise exception 'job % is not running under worker %', p_job_id, p_worker_id
      using errcode = 'insufficient_privilege';
  end if;

  insert into kanban_runs (
    job_id, org_id, workspace_id, correlation_id, board, kanban_tenant,
    phase, deadline_at
  )
  values (
    v_job.id, v_job.org_id, v_job.workspace_id,
    encode(gen_random_bytes(32), 'hex'),
    p_board,
    'job-' || v_job.id::text,
    'claimed',
    now() + make_interval(secs => greatest(coalesce(p_deadline_seconds, 3600), 60))
  )
  on conflict (job_id) do nothing
  returning * into v_run;

  v_created := found;

  if not v_created then
    select * into v_run from kanban_runs where job_id = p_job_id;
  end if;

  if v_created then
    perform write_audit(
      v_job.org_id, v_job.workspace_id, 'agent.kanban.started',
      'kanban_run', v_run.id::text,
      jsonb_build_object('job_id', v_job.id, 'board', p_board, 'worker', p_worker_id)
    );
  end if;

  return v_run;
end;
$fn$;

revoke all on function kanban_run_start(uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function kanban_run_start(uuid, text, text, integer) to service_role;

-- -----------------------------------------------------------------------------
-- Record the cards.
--
-- The dangerous window in this design is: cards created, connection lost,
-- nothing written down. The worker closes it by searching the board for its own
-- correlation token before creating anything, so the recovery path adopts the
-- orphaned chain instead of starting a second one.
--
-- This function is the backstop for the case where that search is wrong. Once a
-- root task is recorded it is frozen: a second, different root is refused
-- loudly rather than silently overwriting the first and orphaning a live chain
-- that will keep spending the host's only core.
-- -----------------------------------------------------------------------------

create or replace function kanban_run_record_tasks(
  p_job_id           uuid,
  p_worker_id        text,
  p_correlation_id   text,
  p_root_task_id     text,
  p_verifier_task_id text,
  p_task_ids         text[]
)
returns kanban_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job agent_jobs;
  v_run kanban_runs;
begin
  select * into v_job from agent_jobs where id = p_job_id for update;

  if not found then
    raise exception 'job % not found', p_job_id;
  end if;

  if v_job.status <> 'running' or v_job.claimed_by is distinct from p_worker_id then
    raise exception 'job % is not running under worker %', p_job_id, p_worker_id
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_run from kanban_runs where job_id = p_job_id for update;

  if not found then
    raise exception 'job % has no kanban run', p_job_id;
  end if;

  if v_run.correlation_id is distinct from p_correlation_id then
    raise exception 'correlation mismatch for job %', p_job_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_run.root_task_id is not null then
    if v_run.root_task_id is distinct from p_root_task_id then
      raise exception
        'kanban run for job % already points at root task %; refusing to repoint it at %',
        p_job_id, v_run.root_task_id, p_root_task_id
        using errcode = 'restrict_violation';
    end if;
    return v_run;
  end if;

  update kanban_runs
     set root_task_id     = p_root_task_id,
         verifier_task_id = p_verifier_task_id,
         task_ids         = coalesce(p_task_ids, '{}'),
         phase            = case when phase = 'claimed' then 'orchestrating'::kanban_run_phase
                                 else phase end,
         updated_at       = now()
   where job_id = p_job_id
  returning * into v_run;

  perform write_audit(
    v_run.org_id, v_run.workspace_id, 'agent.kanban.dispatched',
    'kanban_run', v_run.id::text,
    jsonb_build_object('job_id', p_job_id, 'root_task_id', p_root_task_id,
                       'tasks', coalesce(array_length(p_task_ids, 1), 0))
  );

  return v_run;
end;
$fn$;

revoke all on function kanban_run_record_tasks(uuid, text, text, text, text, text[])
  from public, anon, authenticated;
grant execute on function kanban_run_record_tasks(uuid, text, text, text, text, text[]) to service_role;

-- -----------------------------------------------------------------------------
-- Move the phase on.
--
-- Called on every poll. It always bumps the poll counter -- which is how a
-- stuck bridge is diagnosable from SQL rather than from a log -- and writes an
-- audit row only when the phase actually changes.
--
-- Terminal is terminal. A late poll arriving after the run completed returns
-- the row unchanged, the same way finish_agent_job treats a duplicate report,
-- so a worker that reconnects mid-write cannot rewrite a decided outcome.
-- -----------------------------------------------------------------------------

create or replace function kanban_run_advance(
  p_job_id         uuid,
  p_worker_id      text,
  p_correlation_id text,
  p_phase          kanban_run_phase,
  p_verdict        text default null,
  p_blocked_reason text default null,
  p_error          text default null,
  p_result         jsonb default null
)
returns kanban_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job      agent_jobs;
  v_run      kanban_runs;
  v_terminal boolean;
  v_changed  boolean;
begin
  select * into v_job from agent_jobs where id = p_job_id for update;

  if not found then
    raise exception 'job % not found', p_job_id;
  end if;

  if v_job.status <> 'running' or v_job.claimed_by is distinct from p_worker_id then
    raise exception 'job % is not running under worker %', p_job_id, p_worker_id
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_run from kanban_runs where job_id = p_job_id for update;

  if not found then
    raise exception 'job % has no kanban run', p_job_id;
  end if;

  if v_run.correlation_id is distinct from p_correlation_id then
    raise exception 'correlation mismatch for job %', p_job_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_run.phase in ('completed', 'failed', 'cancelled', 'timeout') then
    return v_run;
  end if;

  v_terminal := p_phase in ('completed', 'failed', 'cancelled', 'timeout');
  v_changed  := v_run.phase is distinct from p_phase;

  update kanban_runs
     set phase          = p_phase,
         verdict        = coalesce(p_verdict, verdict),
         blocked_reason = case when p_phase = 'blocked' then p_blocked_reason else null end,
         error          = coalesce(p_error, error),
         result         = coalesce(p_result, result),
         polls          = polls + 1,
         last_polled_at = now(),
         updated_at     = now(),
         finished_at    = case when v_terminal then now() else null end
   where job_id = p_job_id
  returning * into v_run;

  if v_changed then
    perform write_audit(
      v_run.org_id, v_run.workspace_id, 'agent.kanban.' || p_phase::text,
      'kanban_run', v_run.id::text,
      jsonb_build_object('job_id', p_job_id, 'verdict', v_run.verdict,
                         'reason', coalesce(p_blocked_reason, p_error))
    );
  end if;

  return v_run;
end;
$fn$;

revoke all on function kanban_run_advance(uuid, text, text, kanban_run_phase, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function kanban_run_advance(uuid, text, text, kanban_run_phase, text, text, text, jsonb)
  to service_role;

-- =============================================================================
-- Cancellation, and the hazard deferral introduces.
--
-- `cancel_agent_job` allows only a `queued` job to be cancelled, and that was an
-- exact statement of the truth: queued meant nothing had started. Deferral
-- changes what the word covers. A bridged job spends almost its whole life
-- `queued` -- handed back between polls -- while four agents work on it.
--
-- So the rule stays (a customer may still cancel) and the consequence is made
-- honest: cancelling the job cancels its run, which the worker can never
-- resurrect because `kanban_run_advance` refuses to move a terminal phase. The
-- cards themselves are stopped by the worker's sweep, because stopping a card
-- needs the CLI and the database has none.
-- =============================================================================

alter table kanban_runs
  add column if not exists cards_stopped_at timestamptz;

comment on column kanban_runs.cards_stopped_at is
  'When the worker stopped this run''s cards. Null on a cancelled run means a chain may still be running for a job nobody is waiting on.';

create or replace function cancel_agent_job(p_job_id uuid)
returns agent_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_job agent_jobs;
begin
  select * into v_job from agent_jobs where id = p_job_id for update;

  if not found or not has_workspace_access(v_job.workspace_id) then
    raise exception 'job % not found', p_job_id using errcode = 'insufficient_privilege';
  end if;

  if v_job.status <> 'queued' then
    raise exception 'job % is %, only queued jobs can be cancelled', p_job_id, v_job.status
      using errcode = 'restrict_violation';
  end if;

  update agent_jobs
     set status = 'cancelled', finished_at = now(), lease_expires_at = null
   where id = p_job_id
  returning * into v_job;

  -- The only addition. A run left open against a cancelled job would keep its
  -- phase for ever and, worse, would be a row the sweep never notices.
  update kanban_runs
     set phase       = 'cancelled',
         finished_at = now(),
         updated_at  = now(),
         error       = coalesce(error, 'the customer cancelled this job')
   where job_id = p_job_id
     and phase not in ('completed', 'failed', 'cancelled', 'timeout');

  perform write_audit(
    v_job.org_id, v_job.workspace_id, 'agent.job.cancelled', 'agent_job', v_job.id::text,
    jsonb_build_object('kind', v_job.kind)
  );

  return v_job;
end;
$fn$;

revoke all on function cancel_agent_job(uuid) from public, anon;
grant execute on function cancel_agent_job(uuid) to authenticated, service_role;

-- One cancelled run whose cards nobody has stopped, marked as taken in the same
-- statement that returns it.
--
-- Marked before the cards are actually stopped, deliberately. If the worker dies
-- between the two, the chain runs to completion and writes an artefact nobody
-- reads -- which is exactly what happened before this function existed, so the
-- worst case of the cleanup failing is the state it was added to improve on. The
-- alternative, marking afterwards, lets two workers both sweep the same run and
-- lets one worker retry it for ever.
create or replace function next_cancelled_kanban_run(p_worker_id text)
returns setof kanban_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_run kanban_runs;
begin
  with candidate as (
    select r.id
    from kanban_runs r
    where r.phase = 'cancelled'
      and r.cards_stopped_at is null
      and coalesce(array_length(r.task_ids, 1), 0) > 0
    order by r.updated_at
    limit 1
    for update skip locked
  )
  update kanban_runs r
     set cards_stopped_at = now(),
         updated_at       = now()
    from candidate c
   where r.id = c.id
  returning r.* into v_run;

  if not found then
    return;
  end if;

  perform write_audit(
    v_run.org_id, v_run.workspace_id, 'agent.kanban.swept',
    'kanban_run', v_run.id::text,
    jsonb_build_object('job_id', v_run.job_id, 'worker', p_worker_id,
                       'tasks', coalesce(array_length(v_run.task_ids, 1), 0))
  );

  return next v_run;
end;
$fn$;

revoke all on function next_cancelled_kanban_run(text) from public, anon, authenticated;
grant execute on function next_cancelled_kanban_run(text) to service_role;
