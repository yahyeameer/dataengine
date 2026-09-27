-- =============================================================================
-- `materiality_gbp` becomes `materiality`.
--
-- The column has never held pounds. It is computed by the agent from whatever
-- figures the customer's own file contained, and the suffix was a guess written
-- into the schema at a time when every customer was a UK accounting practice.
-- `20260927000027` gave workspaces a currency so the dashboard could stop
-- asserting one; this removes the assertion from the column that started it.
--
-- Nothing about the values changes. This is a rename.
--
-- **The jsonb key is a wire format, and that is the part worth care.** The
-- worker sends proposals and deviations as jsonb arrays whose items carry a
-- `materiality_gbp` key, and the worker and the dashboard deploy separately --
-- so between this migration landing and the agent host being rebuilt there is a
-- window where a running worker still sends the old key. If these three
-- functions only read the new one, every proposal written in that window would
-- silently lose its materiality, and a review queue ranked by money would rank
-- by nothing.
--
-- So they read both, newest first. The compatibility arm can be deleted once no
-- worker older than this migration is running anywhere; it costs one coalesce
-- until then, and it is the difference between a rename and an outage.
-- =============================================================================

alter table proposed_changes rename column materiality_gbp to materiality;
alter table deviations rename column materiality_gbp to materiality;

comment on column proposed_changes.materiality is
  'What this change would move, in the workspace''s own currency. Not converted '
  'and not assumed to be sterling; see workspaces.currency.';
comment on column deviations.materiality is
  'What this deviation would move, in the workspace''s own currency.';

-- The two indexes that sort by it follow the column automatically -- an index
-- references a column by number, not by name -- so there is nothing to rebuild.


-- -----------------------------------------------------------------------------
-- The three writers, recreated against the new column.
--
-- Reproduced from `pg_get_functiondef` on a database with every prior migration
-- applied, so the only differences from what is running are the two lines each
-- one needed.
-- -----------------------------------------------------------------------------

create or replace function replace_proposed_changes(
  p_dataset_version_id uuid,
  p_job_id             uuid,
  p_proposals          jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_workspace uuid;
  v_org       uuid;
  v_count     integer;
begin
  select d.workspace_id, w.org_id
    into v_workspace, v_org
  from dataset_versions dv
  join datasets d on d.id = dv.dataset_id
  join workspaces w on w.id = d.workspace_id
  where dv.id = p_dataset_version_id;

  if v_workspace is null then
    raise exception 'dataset version % not found', p_dataset_version_id;
  end if;

  -- decided_at is set because the check constraint requires a non-pending row
  -- to carry one; decided_by stays null, which is how a superseded proposal is
  -- distinguished from one a person actually ruled on.
  update proposed_changes
     set status = 'superseded', decided_at = now(),
         decision_note = 'superseded by a newer analysis'
   where dataset_version_id = p_dataset_version_id
     and status = 'pending';

  insert into proposed_changes (
    workspace_id, dataset_version_id, job_id, group_key, step_type, column_name,
    title, rationale, operation, evidence, confidence, affected_rows, materiality
  )
  select
    v_workspace,
    p_dataset_version_id,
    p_job_id,
    item ->> 'group_key',
    item ->> 'step_type',
    nullif(item ->> 'column_name', ''),
    item ->> 'title',
    item ->> 'rationale',
    coalesce(item -> 'operation', '{}'::jsonb),
    coalesce(item -> 'evidence', '{}'::jsonb),
    (item ->> 'confidence')::change_confidence,
    coalesce((item ->> 'affected_rows')::bigint, 0),
    -- New key first, old key while a pre-rename worker may still be running.
    nullif(coalesce(item ->> 'materiality', item ->> 'materiality_gbp'), '')::numeric
  from jsonb_array_elements(coalesce(p_proposals, '[]'::jsonb)) as item;

  get diagnostics v_count = row_count;

  perform write_audit(
    v_org, v_workspace, 'agent.changes.proposed', 'dataset_version', p_dataset_version_id::text,
    jsonb_build_object('count', v_count, 'job_id', p_job_id)
  );

  return v_count;
end;
$fn$;


create or replace function append_proposed_changes(
  p_dataset_version_id uuid,
  p_job_id             uuid,
  p_proposals          jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_workspace uuid;
  v_org       uuid;
  v_count     integer;
begin
  select d.workspace_id, w.org_id
    into v_workspace, v_org
  from dataset_versions dv
  join datasets d on d.id = dv.dataset_id
  join workspaces w on w.id = d.workspace_id
  where dv.id = p_dataset_version_id;

  if v_workspace is null then
    raise exception 'dataset version % not found', p_dataset_version_id;
  end if;

  -- Deliberately no supersede step. That is the entire difference.
  insert into proposed_changes (
    workspace_id, dataset_version_id, job_id, group_key, step_type, column_name,
    title, rationale, operation, evidence, confidence, affected_rows, materiality
  )
  select
    v_workspace,
    p_dataset_version_id,
    p_job_id,
    item ->> 'group_key',
    item ->> 'step_type',
    nullif(item ->> 'column_name', ''),
    item ->> 'title',
    item ->> 'rationale',
    coalesce(item -> 'operation', '{}'::jsonb),
    coalesce(item -> 'evidence', '{}'::jsonb),
    (item ->> 'confidence')::change_confidence,
    coalesce((item ->> 'affected_rows')::bigint, 0),
    nullif(coalesce(item ->> 'materiality', item ->> 'materiality_gbp'), '')::numeric
  from jsonb_array_elements(coalesce(p_proposals, '[]'::jsonb)) as item;

  get diagnostics v_count = row_count;

  perform write_audit(
    v_org, v_workspace, 'agent.changes.proposed', 'dataset_version', p_dataset_version_id::text,
    jsonb_build_object('count', v_count, 'job_id', p_job_id, 'appended', true)
  );

  return v_count;
end;
$fn$;


create or replace function record_deviations(p_run_id uuid, p_deviations jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_workspace uuid;
  v_count     integer;
begin
  select workspace_id into v_workspace from recipe_runs where id = p_run_id;
  if v_workspace is null then
    raise exception 'run % not found', p_run_id;
  end if;

  insert into deviations (
    run_id, workspace_id, type, severity, group_key, title, detail, column_name,
    source_value, suggested_value, affected_rows, materiality, evidence
  )
  select
    p_run_id,
    v_workspace,
    (item ->> 'type')::deviation_type,
    (item ->> 'severity')::deviation_severity,
    item ->> 'group_key',
    item ->> 'title',
    item ->> 'detail',
    nullif(item ->> 'column_name', ''),
    nullif(item ->> 'source_value', ''),
    nullif(item ->> 'suggested_value', ''),
    coalesce((item ->> 'affected_rows')::bigint, 0),
    nullif(coalesce(item ->> 'materiality', item ->> 'materiality_gbp'), '')::numeric,
    coalesce(item -> 'evidence', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_deviations, '[]'::jsonb)) as item;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;
