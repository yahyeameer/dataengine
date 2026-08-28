-- =============================================================================
-- Categorising a column.
--
-- The first job in this pipeline whose answer is a judgement rather than a
-- measurement. Everything else the agent does is decidable from the data: a
-- duplicate row is duplicated, a date either parses or does not, a total either
-- reconciles or does not. Whether "MOBILE PHONE BILL - O2" is a utility or a
-- communications cost is a question about how this practice keeps its books,
-- and no amount of profiling answers it.
--
-- So this is where the model earns its place, and the safety rule does not
-- change to accommodate it: the job writes *proposals*, not columns. The
-- categories arrive in the same review queue as everything else, are approved
-- by the same person, and are applied by the same apply_cleaning job into the
-- same immutable new version. A model deciding how to label a row is fine. A
-- model deciding it silently is not.
--
-- What the model is shown is the column's distinct values, never its rows --
-- the discipline of PRD section 8. Categorising a vendor list means looking at
-- the vendors, not at what anybody paid them.
--
-- As in 008 and 011: `alter type ... add value` is safe inside a transaction as
-- long as nothing in the same transaction uses the new value, and nothing here
-- does.
-- =============================================================================

alter type agent_job_kind add value if not exists 'categorize_dataset';

-- -----------------------------------------------------------------------------
-- Adding proposals without discarding the ones already on the version.
--
-- replace_proposed_changes supersedes every pending row before inserting,
-- which is right for what it was written for: propose_cleaning re-analyses a
-- whole version, so its second run replaces its first rather than doubling it.
--
-- Categorising is not a re-analysis. It answers a different question about one
-- column, at a moment of the accountant's choosing, and the cleaning queue it
-- arrives beside is still waiting to be decided. Using the replacing variant
-- would silently supersede work someone was halfway through reviewing.
--
-- Same shape otherwise, including the audit line -- a proposal is a proposal
-- however it was arrived at, and the reviewer should not have to know which
-- job wrote it.
-- -----------------------------------------------------------------------------

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
    title, rationale, operation, evidence, confidence, affected_rows, materiality_gbp
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
    nullif(item ->> 'materiality_gbp', '')::numeric
  from jsonb_array_elements(coalesce(p_proposals, '[]'::jsonb)) as item;

  get diagnostics v_count = row_count;

  perform write_audit(
    v_org, v_workspace, 'agent.changes.proposed', 'dataset_version', p_dataset_version_id::text,
    jsonb_build_object('count', v_count, 'job_id', p_job_id, 'appended', true)
  );

  return v_count;
end;
$fn$;

revoke all on function append_proposed_changes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function append_proposed_changes(uuid, uuid, jsonb) to service_role;
