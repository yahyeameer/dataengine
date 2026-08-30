-- =============================================================================
-- Rate limits.
--
-- Two endpoints are worth protecting and the rest are not. Creating a job costs
-- an Opus call and a slice of a single CPU core; signing an upload reserves
-- storage. Everything else in this API reads.
--
-- Three things this deliberately is not:
--
-- **Not middleware.** This codebase has none, and route protection is
-- per-route by design. Adding a middleware layer to hold one counter would be
-- a new architectural seam for a feature that fits inside an existing one.
--
-- **Not a new table.** `agent_jobs.requested_by` and `raw_uploads.uploaded_by`
-- already record who did what and when. A counter table would be a second
-- source of truth for a fact the first one already holds, and it would need its
-- own retention.
--
-- **Not in the route.** `enqueue_agent_job` is `SECURITY DEFINER` and is the
-- only way an authenticated user creates a job. Enforcing here means the limit
-- cannot be bypassed by a different caller, and it holds even if someone adds a
-- second route later and forgets.
--
-- The worker is unaffected: it chains through `enqueue_agent_job_internal`,
-- which is a separate service-role function. A parse fanning out to profile and
-- propose must never be throttled by a limit meant for a human clicking.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The limits.
--
-- Set for a person working, not for a load test. An accountant uploading a
-- month of ledgers and asking a dozen questions stays well inside these; a
-- runaway client loop hits them in seconds.
--
-- `PT429` is a PostgREST convention: a SQLSTATE of PTnnn sets the HTTP status
-- directly, so a throttled caller gets 429 rather than a 500 that reads like a
-- bug in the product.
-- -----------------------------------------------------------------------------

create or replace function rate_limit_jobs_per_window()
returns integer language sql immutable set search_path = public, pg_temp
as $fn$ select 30 $fn$;

create or replace function rate_limit_window_seconds()
returns integer language sql immutable set search_path = public, pg_temp
as $fn$ select 300 $fn$;

create or replace function rate_limit_uploads_per_window()
returns integer language sql immutable set search_path = public, pg_temp
as $fn$ select 20 $fn$;

-- -----------------------------------------------------------------------------
-- Upload throttle, callable from the signing route.
--
-- Returns the number of seconds the caller should wait, or 0 when they are
-- under the limit -- a number the route can put in a message rather than a
-- bare refusal. Counting `raw_uploads` rather than a counter means a reserved
-- row that never completed still counts, which is correct: the cost being
-- limited is the reservation, not the bytes.
-- -----------------------------------------------------------------------------
create or replace function upload_rate_limit_retry_after(p_user uuid default null)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user    uuid := coalesce(p_user, auth.uid());
  v_window  interval := make_interval(secs => rate_limit_window_seconds());
  v_used    integer;
  v_oldest  timestamptz;
begin
  if v_user is null then
    return 0;
  end if;

  select count(*), min(created_at)
    into v_used, v_oldest
    from raw_uploads
   where uploaded_by = v_user
     and created_at > now() - v_window;

  if v_used < rate_limit_uploads_per_window() then
    return 0;
  end if;

  -- When the oldest request in the window ages out, a slot frees.
  return greatest(1, ceil(extract(epoch from (v_oldest + v_window - now())))::integer);
end;
$fn$;

revoke all on function upload_rate_limit_retry_after(uuid) from public, anon;
grant execute on function upload_rate_limit_retry_after(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Job creation, throttled at the chokepoint.
--
-- Identical to the function it replaces except for the block marked below. The
-- rest is reproduced verbatim rather than patched, because a partial redefine
-- of a SECURITY DEFINER function is how authorization checks get lost.
-- -----------------------------------------------------------------------------
create or replace function enqueue_agent_job(
  p_workspace_id       uuid,
  p_kind               agent_job_kind,
  p_payload            jsonb default '{}'::jsonb,
  p_dataset_id         uuid default null,
  p_dataset_version_id uuid default null,
  p_raw_upload_id      uuid default null,
  p_priority           smallint default 100
)
returns agent_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user   uuid := auth.uid();
  v_org    uuid;
  v_job    agent_jobs;
  v_used   integer;
  v_oldest timestamptz;
  v_retry  integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  if not has_workspace_access(p_workspace_id) then
    -- Same wording whether the workspace is absent or someone else's. The API
    -- must not confirm that another tenant's id is real.
    raise exception 'workspace % not found', p_workspace_id using errcode = 'insufficient_privilege';
  end if;

  -- ---- rate limit -----------------------------------------------------
  -- Counted per user rather than per workspace: the cost being protected is
  -- model spend and one CPU core, and both are shared across every workspace
  -- on this deployment. Checked after membership so a throttled response can
  -- never confirm that someone else's workspace id exists.
  --
  -- Deliberately before the dedup below. A client looping on the same request
  -- would otherwise be answered cheaply forever and never learn to stop.
  select count(*), min(created_at)
    into v_used, v_oldest
    from agent_jobs
   where requested_by = v_user
     and created_at > now() - make_interval(secs => rate_limit_window_seconds());

  if v_used >= rate_limit_jobs_per_window() then
    v_retry := greatest(1, ceil(extract(epoch from (
      v_oldest + make_interval(secs => rate_limit_window_seconds()) - now()
    )))::integer);
    raise exception
      'Too many jobs. You have queued % in the last % minute(s); try again in % second(s).',
      v_used, rate_limit_window_seconds() / 60, v_retry
      using errcode = 'PT429';
  end if;
  -- ---- end rate limit -------------------------------------------------

  select org_id into v_org from workspaces where id = p_workspace_id;

  -- Referenced entities must live in the same workspace. Without this a caller
  -- with access to workspace A could aim a job at workspace B's dataset, and
  -- the worker -- holding the service key -- would happily comply.
  if p_dataset_id is not null
     and not exists (select 1 from datasets d
                     where d.id = p_dataset_id and d.workspace_id = p_workspace_id) then
    raise exception 'dataset % is not in workspace %', p_dataset_id, p_workspace_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_raw_upload_id is not null
     and not exists (select 1 from raw_uploads u
                     where u.id = p_raw_upload_id and u.workspace_id = p_workspace_id) then
    raise exception 'upload % is not in workspace %', p_raw_upload_id, p_workspace_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_dataset_version_id is not null
     and not exists (select 1 from dataset_versions dv
                     join datasets d on d.id = dv.dataset_id
                     where dv.id = p_dataset_version_id and d.workspace_id = p_workspace_id) then
    raise exception 'dataset version % is not in workspace %', p_dataset_version_id, p_workspace_id
      using errcode = 'insufficient_privilege';
  end if;

  -- An identical job already waiting or running is returned as-is.
  select * into v_job
  from agent_jobs j
  where j.workspace_id = p_workspace_id
    and j.kind = p_kind
    and j.status in ('queued', 'running')
    and j.dataset_version_id is not distinct from p_dataset_version_id
    and j.raw_upload_id is not distinct from p_raw_upload_id
    and j.payload = coalesce(p_payload, '{}'::jsonb)
  order by j.created_at
  limit 1;

  if found then
    return v_job;
  end if;

  insert into agent_jobs (
    org_id, workspace_id, dataset_id, dataset_version_id, raw_upload_id,
    kind, payload, priority, requested_by
  )
  values (
    v_org, p_workspace_id, p_dataset_id, p_dataset_version_id, p_raw_upload_id,
    p_kind, coalesce(p_payload, '{}'::jsonb), coalesce(p_priority, 100::smallint), v_user
  )
  returning * into v_job;

  perform write_audit(
    v_org, p_workspace_id, 'agent.job.enqueued', 'agent_job', v_job.id::text,
    jsonb_build_object('kind', p_kind, 'dataset_version_id', p_dataset_version_id,
                       'raw_upload_id', p_raw_upload_id)
  );

  return v_job;
end;
$fn$;

revoke all on function enqueue_agent_job(uuid, agent_job_kind, jsonb, uuid, uuid, uuid, smallint)
  from public, anon;
grant execute on function enqueue_agent_job(uuid, agent_job_kind, jsonb, uuid, uuid, uuid, smallint)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The index this makes hot.
--
-- Both counts filter by actor and a recent timestamp. Without these the check
-- adds a sequential scan to every job creation, which would make the throttle
-- more expensive than the thing it protects.
-- -----------------------------------------------------------------------------
create index if not exists agent_jobs_requested_by_created_at_idx
  on agent_jobs (requested_by, created_at desc);

create index if not exists raw_uploads_uploaded_by_created_at_idx
  on raw_uploads (uploaded_by, created_at desc);
