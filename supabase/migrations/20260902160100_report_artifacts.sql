-- =============================================================================
-- Report history, and the recipe's own deliverable.
--
-- Section 21 asks every generated report to record what produced it:
-- organization, workspace, recipe, recipe version, dataset, dataset version,
-- branding snapshot, format, status. Almost all of that already existed in
-- separate rows -- but only as a job result blob, so the trail could be
-- reconstructed by somebody who knew the schema and could not be read.
--
--   report -> recipe v3 -> dataset v17 -> cleaning operations -> branding
--
-- The branding snapshot is the part that cannot be reconstructed at all.
-- Section 19 requires a recipe to *reference* the organisation's current
-- branding rather than copy it, so that renaming "Energy Gain" to "Energy Gain
-- Ltd" changes future reports. The consequence is that the branding table can
-- no longer explain a document produced last year. Storing what was resolved,
-- on the row that records the document, is what makes both true at once.
-- =============================================================================

create type report_artifact_status as enum ('succeeded', 'partial', 'failed');

create table report_artifacts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete cascade,
  workspace_id        uuid not null references workspaces (id) on delete cascade,

  dataset_id          uuid references datasets (id) on delete set null,
  dataset_version_id  uuid references dataset_versions (id) on delete set null,
  recipe_id           uuid references cleaning_recipes (id) on delete set null,
  recipe_version_id   uuid references recipe_versions (id) on delete set null,
  job_id              uuid references agent_jobs (id) on delete set null,

  -- One row per report, listing every format it was asked for. A pack of a PDF
  -- and a workbook is one deliverable, and splitting it into two rows would
  -- make "the September report" two things that can disagree about which
  -- dataset version they came from.
  --
  --   [{"format": "pdf", "path": "...", "bytes": 91234, "ok": true},
  --    {"format": "xlsx", "ok": false, "error": "..."}]
  formats             jsonb not null default '[]'::jsonb,
  bucket              text not null default 'exports',
  status              report_artifact_status not null default 'succeeded',
  error               text,

  -- What the branding *was*, not a pointer to what it is now.
  branding_snapshot   jsonb not null default '{}'::jsonb,

  title               text,
  period              text,
  generated_at        timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null
);

create index report_artifacts_workspace_idx
  on report_artifacts (workspace_id, generated_at desc);
create index report_artifacts_recipe_idx
  on report_artifacts (recipe_id, generated_at desc) where recipe_id is not null;
create index report_artifacts_version_idx on report_artifacts (dataset_version_id);

-- A report is evidence of what was sent to a client. It is written once.
create trigger report_artifacts_immutable
  before update or delete on report_artifacts
  for each row execute function reject_mutation();

-- -----------------------------------------------------------------------------
-- What a recipe produces at the end of a run.
--
-- On the version rather than on the recipe, because it is part of the workflow
-- definition: changing the deliverable from a PDF to a PDF and a workbook is a
-- change to what the recipe does, and a historical run must keep reporting the
-- deliverable it actually produced.
--
-- Deliberately small. It holds formats and an optional title; whose name and
-- colour go on the document is resolved from the organisation at run time
-- (section 19), so there is nothing about branding stored here to go stale.
-- -----------------------------------------------------------------------------

alter table recipe_versions add column report_config jsonb;

-- The prose a person writes about what the recipe is for, and the space for a
-- new version's note. Neither existed: a recipe had a name and a step list.
alter table cleaning_recipes add column description text
  check (description is null or length(description) <= 1000);
alter table cleaning_recipes add column updated_at timestamptz not null default now();

alter table recipe_runs add column report_artifact_id uuid
  references report_artifacts (id) on delete set null;

-- =============================================================================
-- Write path.
-- =============================================================================

create or replace function record_report_artifact(
  p_workspace_id       uuid,
  p_dataset_id         uuid default null,
  p_dataset_version_id uuid default null,
  p_recipe_id          uuid default null,
  p_recipe_version_id  uuid default null,
  p_job_id             uuid default null,
  p_formats            jsonb default '[]'::jsonb,
  p_bucket             text default 'exports',
  p_status             report_artifact_status default 'succeeded',
  p_error              text default null,
  p_branding_snapshot  jsonb default '{}'::jsonb,
  p_title              text default null,
  p_period             text default null,
  p_created_by         uuid default null
)
returns report_artifacts
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_row report_artifacts;
begin
  select org_id into v_org from workspaces where id = p_workspace_id;
  if v_org is null then
    raise exception 'workspace % not found', p_workspace_id;
  end if;

  insert into report_artifacts (
    org_id, workspace_id, dataset_id, dataset_version_id, recipe_id, recipe_version_id,
    job_id, formats, bucket, status, error, branding_snapshot, title, period, created_by
  )
  values (
    v_org, p_workspace_id, p_dataset_id, p_dataset_version_id, p_recipe_id, p_recipe_version_id,
    p_job_id, coalesce(p_formats, '[]'::jsonb), coalesce(p_bucket, 'exports'),
    coalesce(p_status, 'succeeded'), left(p_error, 500),
    coalesce(p_branding_snapshot, '{}'::jsonb), left(p_title, 300), left(p_period, 60),
    p_created_by
  )
  returning * into v_row;

  insert into audit_logs (org_id, workspace_id, actor_user_id, action, entity_type, entity_id, metadata)
  values (
    v_org, p_workspace_id, p_created_by, 'report.generated', 'report_artifact', v_row.id::text,
    jsonb_build_object('status', v_row.status, 'formats', v_row.formats,
                       'branding', v_row.branding_snapshot)
  );

  return v_row;
end;
$fn$;

revoke all on function record_report_artifact(
  uuid, uuid, uuid, uuid, uuid, uuid, jsonb, text, report_artifact_status,
  text, jsonb, text, text, uuid
) from public, anon, authenticated;
grant execute on function record_report_artifact(
  uuid, uuid, uuid, uuid, uuid, uuid, jsonb, text, report_artifact_status,
  text, jsonb, text, text, uuid
) to service_role;

-- -----------------------------------------------------------------------------
-- Attaching that report to the run that produced it.
--
-- Separate from `finish_recipe_run` rather than a new parameter on it. The run
-- guard freezes a row the moment its status leaves 'running', and widening the
-- guard to admit one late column would weaken the immutability that makes a
-- finished run evidence. This runs *before* the run is finished, which is also
-- the truthful order: the deliverable exists, then the run is closed over it.
-- -----------------------------------------------------------------------------

create or replace function attach_run_report(p_run_id uuid, p_report_artifact_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  update recipe_runs
     set report_artifact_id = p_report_artifact_id
   where id = p_run_id and status = 'running';

  return found;
end;
$fn$;

revoke all on function attach_run_report(uuid, uuid) from public, anon, authenticated;
grant execute on function attach_run_report(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Recipe lifecycle a person drives from the Recipes screen.
--
-- `update_recipe_steps` already writes a new version and is unchanged. What was
-- missing is everything around it: describing a recipe, setting the deliverable,
-- turning one off, and copying one to another workspace.
-- -----------------------------------------------------------------------------

create or replace function update_recipe_definition(
  p_recipe_id     uuid,
  p_steps         jsonb default null,
  p_invariants    jsonb default null,
  p_report_config jsonb default null,
  p_change_note   text default null
)
returns recipe_versions
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user       uuid := auth.uid();
  v_recipe     cleaning_recipes;
  v_current    recipe_versions;
  v_org        uuid;
  v_next       integer;
  v_version    recipe_versions;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select * into v_recipe from cleaning_recipes where id = p_recipe_id;
  if not found or not has_workspace_access(v_recipe.workspace_id) then
    raise exception 'recipe % not found', p_recipe_id using errcode = 'insufficient_privilege';
  end if;

  if v_recipe.current_version_id is not null then
    select * into v_current from recipe_versions where id = v_recipe.current_version_id;
  end if;

  -- Null means "carry forward", so a screen that edits only the deliverable
  -- does not have to resend the step list -- and cannot silently truncate it.
  select coalesce(max(version_no) + 1, 1) into v_next
  from recipe_versions where recipe_id = p_recipe_id;

  insert into recipe_versions (
    recipe_id, version_no, steps, invariants, report_config, change_note, created_by
  )
  values (
    p_recipe_id,
    v_next,
    coalesce(p_steps, v_current.steps, '[]'::jsonb),
    coalesce(p_invariants, v_current.invariants, '[]'::jsonb),
    coalesce(p_report_config, v_current.report_config),
    p_change_note,
    v_user
  )
  returning * into v_version;

  update cleaning_recipes
     set current_version_id = v_version.id, updated_at = now()
   where id = p_recipe_id;

  select org_id into v_org from workspaces where id = v_recipe.workspace_id;

  perform write_audit(
    v_org, v_recipe.workspace_id, 'recipe.version.edited', 'recipe_version',
    v_version.id::text,
    jsonb_build_object('recipe_id', p_recipe_id, 'version_no', v_next,
                       'change_note', p_change_note,
                       'report_config', v_version.report_config)
  );

  return v_version;
end;
$fn$;

revoke all on function update_recipe_definition(uuid, jsonb, jsonb, jsonb, text) from public, anon;
grant execute on function update_recipe_definition(uuid, jsonb, jsonb, jsonb, text)
  to authenticated, service_role;

create or replace function set_recipe_enabled(
  p_recipe_id uuid,
  p_enabled   boolean,
  p_reason    text default null
)
returns cleaning_recipes
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_recipe cleaning_recipes;
  v_org    uuid;
begin
  select * into v_recipe from cleaning_recipes where id = p_recipe_id;
  if not found or not has_workspace_access(v_recipe.workspace_id) then
    raise exception 'recipe % not found', p_recipe_id using errcode = 'insufficient_privilege';
  end if;

  update cleaning_recipes
     set enabled = coalesce(p_enabled, true), updated_at = now()
   where id = p_recipe_id
  returning * into v_recipe;

  select org_id into v_org from workspaces where id = v_recipe.workspace_id;

  perform write_audit(
    v_org, v_recipe.workspace_id,
    case when v_recipe.enabled then 'recipe.enabled' else 'recipe.disabled' end,
    'cleaning_recipe', p_recipe_id::text,
    jsonb_build_object('reason', p_reason)
  );

  return v_recipe;
end;
$fn$;

revoke all on function set_recipe_enabled(uuid, boolean, text) from public, anon;
grant execute on function set_recipe_enabled(uuid, boolean, text) to authenticated, service_role;

create or replace function describe_recipe(
  p_recipe_id   uuid,
  p_name        text default null,
  p_description text default null
)
returns cleaning_recipes
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_recipe cleaning_recipes;
begin
  select * into v_recipe from cleaning_recipes where id = p_recipe_id;
  if not found or not has_workspace_access(v_recipe.workspace_id) then
    raise exception 'recipe % not found', p_recipe_id using errcode = 'insufficient_privilege';
  end if;

  update cleaning_recipes
     set name = coalesce(nullif(btrim(p_name), ''), name),
         description = case
           when p_description is null then description
           else nullif(btrim(p_description), '')
         end,
         updated_at = now()
   where id = p_recipe_id
  returning * into v_recipe;

  return v_recipe;
end;
$fn$;

revoke all on function describe_recipe(uuid, text, text) from public, anon;
grant execute on function describe_recipe(uuid, text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Duplicating a recipe.
--
-- The copy starts at version 1 with the source's current steps and no
-- source_signature: a signature is the claim "this recipe owns files of this
-- shape", and two recipes claiming it is exactly what the unique constraint on
-- (workspace_id, source_signature) exists to prevent. The copy earns its own
-- signature the first time somebody runs it against a file.
-- -----------------------------------------------------------------------------

create or replace function duplicate_recipe(
  p_recipe_id           uuid,
  p_name                text default null,
  p_target_workspace_id uuid default null
)
returns cleaning_recipes
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user     uuid := auth.uid();
  v_source   cleaning_recipes;
  v_current  recipe_versions;
  v_target   uuid;
  v_copy     cleaning_recipes;
  v_version  recipe_versions;
  v_org      uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select * into v_source from cleaning_recipes where id = p_recipe_id;
  if not found or not has_workspace_access(v_source.workspace_id) then
    raise exception 'recipe % not found', p_recipe_id using errcode = 'insufficient_privilege';
  end if;

  v_target := coalesce(p_target_workspace_id, v_source.workspace_id);
  if not has_workspace_access(v_target) then
    raise exception 'workspace % not found', v_target using errcode = 'insufficient_privilege';
  end if;

  select * into v_current from recipe_versions where id = v_source.current_version_id;

  insert into cleaning_recipes (
    workspace_id, dataset_id, name, description, source_signature,
    template_origin_id, created_by
  )
  values (
    v_target,
    case when v_target = v_source.workspace_id then v_source.dataset_id else null end,
    left(coalesce(nullif(btrim(p_name), ''), v_source.name || ' (copy)'), 200),
    v_source.description,
    null,
    v_source.id,
    v_user
  )
  returning * into v_copy;

  insert into recipe_versions (
    recipe_id, version_no, steps, invariants, report_config, change_note, created_by
  )
  values (
    v_copy.id, 1,
    coalesce(v_current.steps, '[]'::jsonb),
    coalesce(v_current.invariants, '[]'::jsonb),
    v_current.report_config,
    'Copied from ' || v_source.name,
    v_user
  )
  returning * into v_version;

  update cleaning_recipes set current_version_id = v_version.id where id = v_copy.id;

  select org_id into v_org from workspaces where id = v_target;

  perform write_audit(
    v_org, v_target, 'recipe.duplicated', 'cleaning_recipe', v_copy.id::text,
    jsonb_build_object('source_recipe_id', v_source.id, 'name', v_copy.name)
  );

  select * into v_copy from cleaning_recipes where id = v_copy.id;
  return v_copy;
end;
$fn$;

revoke all on function duplicate_recipe(uuid, text, uuid) from public, anon;
grant execute on function duplicate_recipe(uuid, text, uuid) to authenticated, service_role;

-- =============================================================================
-- RLS. Members of the owning organization read their reports; nobody writes
-- directly.
-- =============================================================================

alter table report_artifacts enable row level security;

create policy report_artifacts_select_members
  on report_artifacts for select to authenticated
  using (has_workspace_access(workspace_id));

grant select on report_artifacts to authenticated;
grant all on report_artifacts to service_role;

-- -----------------------------------------------------------------------------
-- `match_recipe` learns about the deliverable.
--
-- Replaced rather than joined against separately: the replay handler already
-- makes exactly one call to find out what to run, and a second round trip to
-- discover whether that recipe produces a report would be a query per run for
-- one nullable column.
-- -----------------------------------------------------------------------------

drop function if exists match_recipe(uuid, text);

create or replace function match_recipe(p_workspace_id uuid, p_source_signature text)
returns table (
  recipe_id          uuid,
  recipe_name        text,
  recipe_version_id  uuid,
  version_no         integer,
  steps              jsonb,
  invariants         jsonb,
  report_config      jsonb,
  run_count          bigint
)
language sql
security definer
set search_path = public, pg_temp
as $fn$
  select
    r.id,
    r.name,
    v.id,
    v.version_no,
    v.steps,
    v.invariants,
    v.report_config,
    (select count(*) from recipe_runs rr where rr.recipe_version_id = v.id)
  from cleaning_recipes r
  join recipe_versions v on v.id = r.current_version_id
  where r.workspace_id = p_workspace_id
    and r.source_signature = p_source_signature
    and r.enabled
  limit 1;
$fn$;

revoke all on function match_recipe(uuid, text) from public, anon;
grant execute on function match_recipe(uuid, text) to authenticated, service_role;
