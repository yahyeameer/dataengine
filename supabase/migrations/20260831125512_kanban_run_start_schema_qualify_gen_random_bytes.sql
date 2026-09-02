-- =============================================================================
-- Backfilled from the live database on 2026-09-02.
--
-- This migration was applied to project `jweclsvkndyvltchnbcl` on 2026-08-31 and
-- never written to the repository, so the fix below existed in production and
-- nowhere else -- a fresh project built from this directory would have shipped
-- the bug again, and nothing would have said so until the first bridged job
-- failed. Recovered verbatim from `supabase_migrations.schema_migrations`.
--
-- The filename carries the version the database recorded rather than the next
-- number in this directory's own sequence, so the two agree on what this
-- migration is called. Files 15 through 21 predate that and still carry their
-- authored numbers; the *names* match the database, only the numbers skew.
-- =============================================================================

-- `gen_random_bytes` is pgcrypto, and on Supabase pgcrypto lives in the
-- `extensions` schema. kanban_run_start pins `search_path = public, pg_temp`,
-- so the call resolved to nothing and every bridged job failed its three
-- attempts with `function gen_random_bytes(integer) does not exist`.
--
-- `gen_random_uuid()` in the same table's default worked throughout and hid the
-- shape of the problem: it is core Postgres since 13, not pgcrypto.
--
-- Qualified explicitly rather than by adding `extensions` to the search path.
-- This is a SECURITY DEFINER function that mints a capability, and widening the
-- path of one of those is what migration 12 exists to stop.

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
    encode(extensions.gen_random_bytes(32), 'hex'),
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
