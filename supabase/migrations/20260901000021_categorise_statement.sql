-- =============================================================================
-- The one-click categorisation path, and the knowledge monitor behind it.
--
-- Two job kinds and one RPC.
--
-- `categorise_statement` is the whole simple product in a single job: it takes a
-- parsed version, classifies it against the HMRC taxonomy, writes a new
-- immutable version, exports a workbook and validates that workbook before it
-- reports success. It exists as one job rather than as a chain because the
-- customer's question is "is my file ready", and a chain of five jobs answers
-- that with four "yes, but"s -- the gap between approving a change and applying
-- it was exactly the hole a customer's export fell into.
--
-- What does *not* change is what a change is. The job still writes a proposal
-- with its full evidence, that proposal still has to be approved before it can
-- be applied, and applying it still writes a new version with a parent pointer.
-- The only difference is who does the approving, which is what
-- `auto_approve_proposed_changes` below is for -- and it leaves a louder audit
-- trail than a person clicking a button does, not a quieter one.
--
-- `hmrc_knowledge_check` is the opposite kind of job: it looks at official
-- GOV.UK guidance and writes a *report*. It has no path to a categorisation
-- rule, by construction. See docs/HMRC_KNOWLEDGE_MONITOR.md.
--
-- As in 008, 011 and 013: `alter type ... add value` is safe inside a
-- transaction as long as nothing in the same transaction uses the new value,
-- and nothing here does.
-- =============================================================================

alter type agent_job_kind add value if not exists 'categorise_statement';
alter type agent_job_kind add value if not exists 'hmrc_knowledge_check';

-- -----------------------------------------------------------------------------
-- Approval by the agent, recorded as such.
--
-- `decide_proposed_changes` reads `auth.uid()` and refuses without one, which is
-- correct for the route a person clicks and makes it unusable from the worker --
-- the worker holds the service role and has no user session at all.
--
-- The tempting shortcut is to let the worker update `proposed_changes` directly.
-- That would work and it would be wrong: the update would be indistinguishable
-- from a human decision, `decided_by` would be null with nothing saying why, and
-- the audit log would show an approval that nobody made.
--
-- So this is a separate function with a separate audit action. `decided_by`
-- stays null *deliberately* -- no user decided this -- and `decision_note`
-- carries the reason in words. An auditor reading the log can tell the two
-- apart, which is the entire requirement.
--
-- It is narrower than the human path in one further way: it will only approve
-- proposals it can see are non-blocking. A Block-tier finding (confidence low)
-- is never auto-approved; the caller has to deal with it, and the job that owns
-- this path only ever writes medium-tier assignments.
-- -----------------------------------------------------------------------------

create or replace function auto_approve_proposed_changes(
  p_dataset_version_id uuid,
  p_group_keys         text[],
  p_note               text
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
  if p_note is null or btrim(p_note) = '' then
    raise exception 'an automatic approval must record why it was automatic';
  end if;

  select d.workspace_id, w.org_id
    into v_workspace, v_org
  from dataset_versions dv
  join datasets d on d.id = dv.dataset_id
  join workspaces w on w.id = d.workspace_id
  where dv.id = p_dataset_version_id;

  if v_workspace is null then
    raise exception 'dataset version % not found', p_dataset_version_id;
  end if;

  update proposed_changes
     set status        = 'approved'::proposed_change_status,
         decided_by    = null,
         decided_at    = now(),
         decision_note = p_note
   where dataset_version_id = p_dataset_version_id
     and group_key = any (p_group_keys)
     and status = 'pending'
     -- Never a blocking finding. Those exist to stop a run and a machine must
     -- not be able to wave one through.
     and confidence <> 'low'::change_confidence;

  get diagnostics v_count = row_count;

  perform write_audit(
    v_org, v_workspace, 'agent.changes.auto_approved',
    'dataset_version', p_dataset_version_id::text,
    jsonb_build_object(
      'group_keys', to_jsonb(p_group_keys),
      'count', v_count,
      'note', p_note,
      'decided_by', 'agent'
    )
  );

  return v_count;
end;
$fn$;

revoke all on function auto_approve_proposed_changes(uuid, text[], text)
  from public, anon, authenticated;
grant execute on function auto_approve_proposed_changes(uuid, text[], text) to service_role;


-- -----------------------------------------------------------------------------
-- Cached official guidance.
--
-- One row per GOV.UK content item the agent has looked at, keyed by the API
-- path. The cache is what keeps the agent off the network: guidance is consulted
-- when an entry is missing or stale, never per transaction, and a run over four
-- thousand rows makes at most a handful of requests.
--
-- `body_hash` rather than the body. The monitor needs to know *that* a page
-- changed, and storing HMRC's prose would be both pointless and a licensing
-- question nobody needs to answer.
-- -----------------------------------------------------------------------------

create table if not exists hmrc_sources (
  id                uuid primary key default gen_random_uuid(),
  -- The GOV.UK content path, e.g. '/expenses-if-youre-self-employed'.
  content_path      text not null unique,
  url               text not null,
  title             text not null,
  summary           text,
  -- GOV.UK's own timestamp for the guidance, not ours.
  public_updated_at timestamptz,
  body_hash         text not null,
  -- Which of our categories this page is evidence about. Free text rather than
  -- an enum: the taxonomy lives in the worker, and a database enum that has to
  -- be migrated whenever a category is renamed is a coupling with no benefit.
  categories        text[] not null default '{}',
  checked_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

create index if not exists hmrc_sources_checked_idx on hmrc_sources (checked_at desc);

-- Global, not per-tenant: this is public guidance from GOV.UK, identical for
-- every customer. Readable by any signed-in user, writable only by the worker.
alter table hmrc_sources enable row level security;

drop policy if exists hmrc_sources_read on hmrc_sources;
create policy hmrc_sources_read on hmrc_sources
  for select to authenticated using (true);


-- -----------------------------------------------------------------------------
-- Change reports.
--
-- The output of the knowledge monitor, and the *only* thing it produces. There
-- is deliberately no column here that a categorisation rule reads. A change on
-- a government website must never alter how a customer's historical accounts
-- were classified; it raises a report, a person reads it, and if a rule should
-- change it changes in code, with a test, through review.
--
-- `status` tracks the human side of that loop so a report cannot be silently
-- lost, and it is the only mutable column.
-- -----------------------------------------------------------------------------

create table if not exists hmrc_change_reports (
  id                 uuid primary key default gen_random_uuid(),
  source_id          uuid not null references hmrc_sources (id) on delete cascade,
  detected_at        timestamptz not null default now(),

  title              text not null,
  url                text not null,
  public_updated_at  timestamptz,
  affected_categories text[] not null default '{}',
  what_changed       text not null,
  potential_impact   text not null,
  recommended_action text not null,

  -- open -> reviewed -> actioned | dismissed. Text with a check rather than an
  -- enum, because this vocabulary is about our own process and will move.
  status             text not null default 'open'
    check (status in ('open', 'reviewed', 'actioned', 'dismissed')),
  reviewed_by        uuid references auth.users (id) on delete set null,
  reviewed_at        timestamptz,
  review_note        text,

  created_at         timestamptz not null default now()
);

create index if not exists hmrc_change_reports_open_idx
  on hmrc_change_reports (detected_at desc) where status = 'open';

alter table hmrc_change_reports enable row level security;

drop policy if exists hmrc_change_reports_read on hmrc_change_reports;
create policy hmrc_change_reports_read on hmrc_change_reports
  for select to authenticated using (true);

-- The facts of what was detected are evidence and do not change. Only the
-- review fields move, and only forwards.
create or replace function hmrc_change_reports_guard()
returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'hmrc_change_reports is append-only: rows may not be deleted'
      using errcode = 'restrict_violation';
  end if;

  if new.source_id     is distinct from old.source_id
     or new.title      is distinct from old.title
     or new.url        is distinct from old.url
     or new.what_changed is distinct from old.what_changed
     or new.detected_at is distinct from old.detected_at then
    raise exception 'a change report may only have its review updated'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$fn$;

drop trigger if exists hmrc_change_reports_guard on hmrc_change_reports;
create trigger hmrc_change_reports_guard
  before update or delete on hmrc_change_reports
  for each row execute function hmrc_change_reports_guard();


-- -----------------------------------------------------------------------------
-- Recording a check.
--
-- Upserts the source and, when the body hash moved, writes one change report.
-- Both in one function so a detected change can never be recorded without the
-- source row that evidences it, or the other way round.
-- -----------------------------------------------------------------------------

create or replace function record_hmrc_source(
  p_content_path      text,
  p_url               text,
  p_title             text,
  p_summary           text,
  p_public_updated_at timestamptz,
  p_body_hash         text,
  p_categories        text[],
  p_impact            text default null,
  p_action            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_existing hmrc_sources;
  v_source   hmrc_sources;
  v_report   uuid := null;
begin
  select * into v_existing from hmrc_sources where content_path = p_content_path;

  insert into hmrc_sources (
    content_path, url, title, summary, public_updated_at, body_hash, categories, checked_at
  )
  values (
    p_content_path, p_url, p_title, p_summary, p_public_updated_at, p_body_hash,
    coalesce(p_categories, '{}'), now()
  )
  on conflict (content_path) do update
    set url               = excluded.url,
        title             = excluded.title,
        summary           = excluded.summary,
        public_updated_at = excluded.public_updated_at,
        body_hash         = excluded.body_hash,
        categories        = excluded.categories,
        checked_at        = now()
  returning * into v_source;

  -- A first sighting is not a change. Only a page we had already seen, whose
  -- content has since moved, is worth a person's attention.
  if v_existing.id is not null and v_existing.body_hash is distinct from p_body_hash then
    insert into hmrc_change_reports (
      source_id, title, url, public_updated_at, affected_categories,
      what_changed, potential_impact, recommended_action
    )
    values (
      v_source.id, v_source.title, v_source.url, v_source.public_updated_at,
      coalesce(p_categories, '{}'),
      format(
        'The guidance at %s changed. Previously seen %s; GOV.UK now reports %s.',
        v_source.url,
        to_char(v_existing.checked_at, 'DD Mon YYYY'),
        coalesce(to_char(p_public_updated_at, 'DD Mon YYYY'), 'no publication date')
      ),
      coalesce(p_impact, 'May affect how the listed categories are classified.'),
      coalesce(
        p_action,
        'Review the guidance against the categorisation rules for the listed categories. '
        || 'Rules change in code, with a test, through review -- never automatically.'
      )
    )
    returning id into v_report;
  end if;

  return jsonb_build_object(
    'source_id', v_source.id,
    'changed', v_report is not null,
    'change_report_id', v_report
  );
end;
$fn$;

revoke all on function record_hmrc_source(text, text, text, text, timestamptz, text, text[], text, text)
  from public, anon, authenticated;
grant execute on function record_hmrc_source(text, text, text, text, timestamptz, text, text[], text, text)
  to service_role;
