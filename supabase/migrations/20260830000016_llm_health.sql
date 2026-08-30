-- =============================================================================
-- Making silent LLM degradation visible.
--
-- The router degrades every model call to the rule engine on timeout, on an
-- unreachable endpoint, on malformed JSON and on a missing key. That is the
-- right behaviour -- a month-end must not fail because an API is down -- but it
-- means the failure has no failure. The job succeeds, proposals appear, and the
-- only symptom is that the explanations get plainer.
--
-- The signal already exists: `model_used` is written on every task that calls a
-- model, and stays null when the fallback ran. Nothing read it. These two views
-- are the whole fix -- no new table, no new service, no agent.
--
-- Two traps are handled here rather than left for whoever writes the query:
--
--   1. `propose_cleaning` nests it under `summary`; everything else puts it at
--      the top level. A flat `result->>'model_used'` reads null for the
--      highest-volume task and looks like total degradation. That exact mistake
--      was made during development. `llm_model_used()` is the one place that
--      knows the difference.
--
--   2. Jobs that ran before the instrumentation existed have no `model_used`
--      and never will. Counting them as degraded makes the signal permanently
--      red and therefore useless. The cutoff is derived from the data -- the
--      first job that ever recorded a model -- so it needs no maintenance and
--      cannot drift out of date.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Where the model name lives, for any job kind.
-- -----------------------------------------------------------------------------
create or replace function llm_model_used(p_result jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $fn$
  -- propose_cleaning nests it; every other kind is top level. Checking both
  -- costs nothing and means callers cannot get this wrong.
  select coalesce(
    p_result -> 'summary' ->> 'model_used',
    p_result ->> 'model_used'
  );
$fn$;

comment on function llm_model_used(jsonb) is
  'Extracts model_used from an agent_jobs.result, handling the nested location used by propose_cleaning.';

-- -----------------------------------------------------------------------------
-- Which kinds are expected to call a model at all.
--
-- Deliberately a function rather than a literal in three places: when a new
-- job kind starts calling the model, this is the only line that changes.
-- -----------------------------------------------------------------------------
create or replace function llm_backed_kinds()
returns agent_job_kind[]
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select array[
    'propose_cleaning',
    'generate_report',
    'query_dataset',
    'categorize_dataset'
  ]::agent_job_kind[];
$fn$;

-- -----------------------------------------------------------------------------
-- Per-job operator view: "what happened to job X?"
--
-- Everything an operator needs at 2am in one row, without joining four tables
-- from memory. No customer figures are exposed -- names and counts only.
-- -----------------------------------------------------------------------------
create or replace view agent_job_telemetry as
select
  j.id                                   as job_id,
  j.kind,
  j.status,
  j.org_id,
  j.workspace_id,
  w.name                                 as workspace_name,
  j.dataset_id,
  d.name                                 as dataset_name,
  j.dataset_version_id,
  j.claimed_by                           as worker_id,
  j.attempts,
  j.max_attempts,
  j.created_at,
  j.started_at,
  j.finished_at,
  round(extract(epoch from (j.finished_at - j.started_at))::numeric, 2) as duration_seconds,
  j.lease_expires_at,
  llm_model_used(j.result)               as model_used,
  -- The point of the whole migration. A succeeded job of an LLM-backed kind
  -- with no model recorded means the rule engine answered and nobody was told.
  (
    j.status = 'succeeded'
    and j.kind = any (llm_backed_kinds())
    and llm_model_used(j.result) is null
  )                                      as llm_fell_back,
  j.error,
  j.progress
from agent_jobs j
left join workspaces w on w.id = j.workspace_id
left join datasets   d on d.id = j.dataset_id;

comment on view agent_job_telemetry is
  'One row per job with worker, timing, model and fallback state. The operator view for "what happened to job X?".';

-- -----------------------------------------------------------------------------
-- Aggregate health signal: "is the model actually running?"
--
-- One row per LLM-backed kind over a rolling window. `degraded` being non-zero
-- is the alert condition, and `first_degraded_at` answers the question that
-- always follows it -- when did this start?
--
-- categorize_dataset is reported alongside the others but its semantics differ
-- and the column names say so: it raises JobError rather than falling back
-- (jobs.py, handle_categorize_dataset), so its degradation shows up as
-- `failed_jobs`, not as `degraded`.
-- -----------------------------------------------------------------------------
create or replace view agent_llm_health as
with instrumented_since as (
  -- Self-calibrating cutoff: the first job that ever recorded a model. Jobs
  -- older than that predate the instrumentation and are not degradation.
  select coalesce(min(created_at), now()) as t
  from agent_jobs
  where llm_model_used(result) is not null
),
scoped as (
  select j.*
  from agent_jobs j, instrumented_since i
  where j.kind = any (llm_backed_kinds())
    and j.created_at >= i.t
)
select
  s.kind,
  count(*) filter (where s.status = 'succeeded')                                as succeeded,
  count(*) filter (where s.status = 'failed')                                   as failed_jobs,
  count(*) filter (where s.status = 'succeeded'
                     and llm_model_used(s.result) is not null)                  as model_ran,
  count(*) filter (where s.status = 'succeeded'
                     and llm_model_used(s.result) is null)                      as degraded,
  min(s.created_at) filter (where s.status = 'succeeded'
                     and llm_model_used(s.result) is null)                      as first_degraded_at,
  max(s.created_at) filter (where s.status = 'succeeded'
                     and llm_model_used(s.result) is null)                      as last_degraded_at,
  array_remove(array_agg(distinct llm_model_used(s.result)), null)              as models_seen,
  array_remove(array_agg(distinct s.claimed_by), null)                          as workers_seen,
  round(avg(extract(epoch from (s.finished_at - s.started_at)))::numeric, 2)    as avg_seconds
from scoped s
group by s.kind
order by degraded desc, s.kind;

comment on view agent_llm_health is
  'Per-kind LLM health since instrumentation began. degraded > 0 means jobs succeeded on the rule-engine fallback with nobody told.';

-- -----------------------------------------------------------------------------
-- Grants.
--
-- Both views read agent_jobs, which is protected by RLS on the underlying
-- table. A signed-in accountant therefore sees only their own workspaces'
-- rows through agent_job_telemetry, which is the correct behaviour for a
-- dashboard tile. The aggregate view is operator-facing and stays service-role
-- only -- a per-tenant fallback count is not something a customer needs.
-- -----------------------------------------------------------------------------
revoke all on function llm_model_used(jsonb) from public, anon;
grant execute on function llm_model_used(jsonb) to authenticated, service_role;

revoke all on function llm_backed_kinds() from public, anon;
grant execute on function llm_backed_kinds() to authenticated, service_role;

revoke all on agent_job_telemetry from public, anon;
grant select on agent_job_telemetry to authenticated, service_role;

revoke all on agent_llm_health from public, anon, authenticated;
grant select on agent_llm_health to service_role;
