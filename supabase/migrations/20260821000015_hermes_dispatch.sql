-- =============================================================================
-- Pushing a job to an agent instead of waiting for one to ask.
--
-- The queue protocol in 006 was written for a worker that polls: it calls
-- `claim_agent_job`, gets whatever is oldest and highest priority, and runs it.
-- That is the right shape for a process whose whole life is the loop.
--
-- The Hermes Agent is not that process. It is woken by a webhook carrying one
-- specific job, and it needs to take *that* job -- not whatever happened to be
-- at the head of the queue when it woke. Handing it the wrong row would be
-- worse than handing it nothing: the payload it was given describes one file
-- and the row it claimed describes another, and every check downstream is
-- against the row.
--
-- So one function, and one seeded worker row. No new tables: `agent_jobs`
-- remains the single record of what work exists and what became of it, which is
-- what lets the dashboard's existing poll keep working with no change at all.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Claim one named job.
--
-- Deliberately a sibling of `claim_agent_job` rather than a parameter on it.
-- The two have genuinely different failure modes -- "the queue is empty" is
-- routine and returns nothing, while "that specific job is not claimable" is a
-- caller error worth distinguishing -- and folding them together would mean a
-- null p_job_id silently falling back to claiming something else.
--
-- Everything else matches its sibling exactly: the same lease arithmetic, the
-- same attempt increment, the same `for update skip locked`, the same treatment
-- of an expired lease as reclaimable. A job pushed to Hermes that dies in
-- flight must still be recoverable by any future worker, so the row it leaves
-- behind has to look identical to one a polling worker abandoned.
-- -----------------------------------------------------------------------------

create or replace function claim_agent_job_by_id(
  p_job_id         uuid,
  p_worker_id      text,
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
     where j.id = p_job_id
       -- Queued, or running on a lease that has already lapsed. A job still
       -- held by a live worker is not up for grabs, which is what stops a
       -- duplicate webhook from handing the same file to two agents.
       and (
             j.status = 'queued'
             or (j.status = 'running' and j.lease_expires_at < now())
           )
       and j.attempts < j.max_attempts
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
    -- Empty rather than an exception. The caller has to distinguish "already
    -- running" from "does not exist" anyway, and it can read the row to find
    -- out; raising here would turn an ordinary double-click into a 500.
    return;
  end if;

  update agent_workers
     set jobs_claimed = jobs_claimed + 1,
         last_seen_at = now()
   where id = p_worker_id;

  return next v_job;
end;
$fn$;

revoke all on function claim_agent_job_by_id(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function claim_agent_job_by_id(uuid, text, integer) to service_role;

-- -----------------------------------------------------------------------------
-- The agent as a registered worker.
--
-- `agent_jobs.claimed_by` references `agent_workers`, so a job cannot be
-- claimed on behalf of a host the registry has never heard of. The Hermes Agent
-- does not register itself -- it holds no database credentials by design, and
-- the web app calls the queue functions on its behalf -- so the row is seeded
-- here instead.
--
-- `last_seen_at` starts in the past on purpose. The dashboard reads this row to
-- decide whether to show "Agent online", and a freshly migrated database has
-- not heard from the agent; claiming otherwise would put a green light next to
-- a service nobody has spoken to yet. The first callback moves it forward.
--
-- Capabilities are left empty. That column steers `claim_agent_job`'s p_kinds
-- filter, which this agent never calls -- it is told which job to take. An
-- empty array here means "announces nothing", which is honest: what this agent
-- can actually do is decided by the skills installed on it, not by a column
-- the web app would have to keep in sync.
-- -----------------------------------------------------------------------------

insert into agent_workers (id, hostname, version, capabilities, last_seen_at, metadata)
values (
  'hermes-agent',
  'hermes-agent-bwlq',
  'hostinger-hermes',
  '{}',
  now() - interval '1 day',
  jsonb_build_object(
    'kind', 'push',
    'note', 'Hostinger Hermes Agent. Woken by webhook; holds no database credentials.'
  )
)
on conflict (id) do nothing;
