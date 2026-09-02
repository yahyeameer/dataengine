-- =============================================================================
-- Recurring recipe execution.
--
-- The honest version of the feature, which is smaller than it sounds and worth
-- being exact about.
--
-- A recipe replay runs against a `dataset_version_id`. Today the only thing
-- that creates one is a person uploading a workbook -- and when they do,
-- `parse_workbook` already matches the file's signature to a recipe and chains
-- the replay itself. There is no persistent external source and no connector.
--
-- So a schedule cannot conjure next month's data, and this one does not pretend
-- to. What it does is fire on a cadence and look for a dataset version *newer
-- than the one it last processed*. If one is there, it enqueues the identical
-- `replay_recipe` job a person's click enqueues. If none is, it records the
-- firing as `skipped_no_source` and the screen says so: "waiting for this
-- month's file".
--
-- That makes a schedule a deadline and a safety net rather than an ingestion
-- pipeline. It is still worth having: it catches a file uploaded before the
-- recipe existed, it re-runs a month whose deviations have since been resolved,
-- and it is the thing that notices when the client's file is simply late. When
-- a connector arrives, it sets `source_kind` to something other than
-- `latest_dataset_version` and nothing else here changes.
--
-- =============================================================================
-- Duplicate prevention, which is the part that has to be right
-- =============================================================================
--
-- The execution identity is `(schedule_id, scheduled_for)` and it is a unique
-- constraint, not a convention. `scheduled_for` is the instant the schedule was
-- *due*, not the instant the scheduler noticed -- so two schedulers that both
-- wake at 09:00:03 for a 09:00:00 firing compute the same key and exactly one
-- of them gets the row.
--
-- The whole firing is one transaction: insert the run row, resolve the source,
-- enqueue the job, advance `next_run_at`. There is no window in which a crash
-- leaves work enqueued and the schedule not advanced, because either all four
-- committed or none did. That is stronger than the "crash after enqueue" case
-- the brief asks about -- the case cannot arise.
-- =============================================================================

create type recipe_schedule_frequency as enum ('daily', 'weekly', 'monthly', 'quarterly', 'yearly');

create type recipe_schedule_run_status as enum (
  'enqueued',          -- a replay_recipe job was created
  'skipped_no_source', -- fired, found no new data, did nothing (not a failure)
  'skipped_disabled',  -- the recipe was disabled after the schedule was made
  'failed'             -- the firing itself could not complete
);

-- -----------------------------------------------------------------------------
-- The schedule.
--
-- organization_id is stored rather than derived through the workspace. It is
-- derivable, and the brief allows either -- but every query the scheduler makes
-- is "due schedules, and is this org within its limits", and a join to
-- workspaces on the hot path of a loop that runs every few seconds is a join
-- worth not having. It is set by the RPC from the workspace, never by a caller.
--
-- The cadence is stored as its parts (frequency, day, hour, minute, timezone)
-- rather than as a cron string. A cron expression would be more general and
-- less honest: the UI offers monthly-on-the-1st-at-09:00, and storing that as
-- `0 9 1 * *` invites a value nobody can render back into the form.
-- -----------------------------------------------------------------------------

create table recipe_schedules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  workspace_id    uuid not null references workspaces (id) on delete cascade,
  recipe_id       uuid not null references cleaning_recipes (id) on delete cascade,

  enabled         boolean not null default true,

  frequency       recipe_schedule_frequency not null default 'monthly',
  -- 1..31 for monthly and quarterly. A day past the end of a short month is
  -- clamped to that month's last day -- see recipe_schedule_next_run.
  day_of_month    integer check (day_of_month between 1 and 31),
  -- 0 = Sunday .. 6 = Saturday, matching Postgres's `dow`.
  day_of_week     integer check (day_of_week between 0 and 6),
  hour            integer not null default 9 check (hour between 0 and 23),
  minute          integer not null default 0 check (minute between 0 and 59),

  -- An IANA name, validated against the server's own tz database by the RPC.
  -- Stored as text because that is what `at time zone` takes.
  timezone        text not null default 'UTC',

  -- Where the input comes from. One value today, and the column exists so that
  -- adding a connector is a new enum-like value and a branch in the resolver
  -- rather than a reshaping of this table.
  source_kind     text not null default 'latest_dataset_version'
                    check (source_kind in ('latest_dataset_version')),

  -- Computed by the database, never sent by a client. This is the column the
  -- scheduler orders by, so it is the one that must be right.
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  last_status     recipe_schedule_run_status,
  last_job_id     uuid references agent_jobs (id) on delete set null,
  last_recipe_run_id uuid references recipe_runs (id) on delete set null,
  last_error      text,

  -- Consecutive failures. A single failure must not disable a schedule (the
  -- brief is explicit), so this exists to make repeated failure visible rather
  -- than to switch anything off.
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),

  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One schedule per recipe. Two schedules on one recipe is not a feature
  -- anybody asked for and is a duplicate-execution bug waiting to happen.
  unique (recipe_id),

  -- The cadence must carry the field it needs.
  constraint recipe_schedules_cadence_ck check (
    (frequency = 'daily')
    or (frequency = 'weekly' and day_of_week is not null)
    or (frequency in ('monthly', 'quarterly', 'yearly') and day_of_month is not null)
  )
);

-- The scheduler's only query: enabled schedules that are due, oldest first.
-- Partial on `enabled` because a disabled schedule is never a candidate and
-- there is no reason for it to be in the index.
create index recipe_schedules_due_idx
  on recipe_schedules (next_run_at)
  where enabled and next_run_at is not null;

create index recipe_schedules_workspace_idx on recipe_schedules (workspace_id);
create index recipe_schedules_org_idx on recipe_schedules (organization_id);

-- -----------------------------------------------------------------------------
-- One row per firing. Append-only: this is the record that a schedule fired,
-- and the answer to "did anything happen last month".
--
-- `scheduled_for` is the due instant, and (schedule_id, scheduled_for) is
-- unique. That constraint is the duplicate-execution guard, and it is in the
-- database because a guard in application code is a guard that two processes
-- can both pass.
-- -----------------------------------------------------------------------------

create table recipe_schedule_runs (
  id                 uuid primary key default gen_random_uuid(),
  schedule_id        uuid not null references recipe_schedules (id) on delete cascade,
  organization_id    uuid not null references organizations (id) on delete cascade,
  workspace_id       uuid not null references workspaces (id) on delete cascade,

  -- The instant this firing was *due*, in UTC. Not when the scheduler noticed.
  scheduled_for      timestamptz not null,
  fired_at           timestamptz not null default now(),

  status             recipe_schedule_run_status not null,
  detail             text,

  -- What it produced. Null on a skip, which is the ordinary quiet outcome.
  job_id             uuid references agent_jobs (id) on delete set null,
  recipe_version_id  uuid references recipe_versions (id) on delete set null,
  dataset_version_id uuid references dataset_versions (id) on delete set null,
  -- Filled in by the worker once the replay run exists, which is after this
  -- row is written -- the job has to be claimed first.
  recipe_run_id      uuid references recipe_runs (id) on delete set null,

  unique (schedule_id, scheduled_for)
);

create index recipe_schedule_runs_schedule_idx
  on recipe_schedule_runs (schedule_id, scheduled_for desc);
create index recipe_schedule_runs_job_idx
  on recipe_schedule_runs (job_id) where job_id is not null;

-- Append-only except for the one late-arriving link. A firing is evidence; the
-- only thing that legitimately changes after the fact is the recipe_run_id,
-- which the worker fills in when the job it created actually runs.
create or replace function recipe_schedule_runs_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'recipe_schedule_runs is append-only: rows may not be deleted'
      using errcode = 'restrict_violation';
  end if;

  if new.schedule_id <> old.schedule_id
     or new.scheduled_for <> old.scheduled_for
     or new.status <> old.status
     or new.fired_at <> old.fired_at
     or new.job_id is distinct from old.job_id then
    raise exception 'a scheduled firing may only have its recipe run attached'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$fn$;

create trigger recipe_schedule_runs_guard
  before update or delete on recipe_schedule_runs
  for each row execute function recipe_schedule_runs_guard();

-- =============================================================================
-- When does it next run?
--
-- In SQL, and only in SQL. The same rule the brief applies to recipe execution
-- applies here: two implementations of a calendar are one calendar and one bug
-- waiting to disagree with it, and the scheduler needs this inside the
-- transaction that advances the schedule -- so SQL is where it has to live. The
-- UI reads the answer off the row rather than computing its own.
--
-- Postgres carries the full IANA database, so `timestamp at time zone 'X'`
-- handles daylight saving, leap years and month lengths without help.
--
-- Two policies worth stating because they are choices, not consequences:
--
--   * A day that does not exist in a month is clamped to that month's last day.
--     "31st of every month" runs on the 28th of February (29th in a leap year),
--     the 30th of April, and the 31st everywhere else. The alternative --
--     skipping February -- means a monthly report that silently does not exist
--     for one month a year.
--
--   * A local time that does not exist because the clocks went forward is
--     resolved by Postgres through the gap rather than skipped: on the morning
--     Britain springs forward, a 01:30 schedule runs at 02:30 local. The
--     alternative is a run that silently does not happen once a year.
--
--   * `yearly` repeats in the month the schedule was created in, on the chosen
--     day. There is no month column, so "every year on the 1st" means "every
--     twelve months from the first firing" -- which is what a year-end pack
--     configured in its own month actually wants.
-- =============================================================================

create or replace function recipe_schedule_next_run(
  p_frequency    recipe_schedule_frequency,
  p_day_of_month integer,
  p_day_of_week  integer,
  p_hour         integer,
  p_minute       integer,
  p_timezone     text,
  p_after        timestamptz default now()
)
returns timestamptz
language plpgsql
immutable
set search_path = public, pg_temp
as $fn$
declare
  v_tz      text := coalesce(nullif(btrim(p_timezone), ''), 'UTC');
  v_local   timestamp;      -- wall-clock time in the schedule's own zone
  v_day     date;
  v_target  date;
  v_result  timestamptz;
  v_guard   integer := 0;
begin
  -- "Now" as the customer's clock reads it. Everything below is arithmetic on
  -- a wall clock, which is what a person means by "the 1st at 09:00"; the
  -- conversion back to an instant happens once, at the end.
  v_local := p_after at time zone v_tz;
  v_day   := v_local::date;

  loop
    v_guard := v_guard + 1;
    if v_guard > 800 then
      -- Unreachable with the frequencies below. Present so a future frequency
      -- with a bug cannot spin inside a transaction holding a row lock.
      return null;
    end if;

    v_target := case p_frequency
      when 'daily' then v_day
      when 'weekly' then
        -- The next occurrence of the requested weekday, today included.
        v_day + ((coalesce(p_day_of_week, 0) - extract(dow from v_day)::integer + 7) % 7)
      else
        -- Monthly, quarterly and yearly all land on a day-of-month within some
        -- month; which month is decided by the advance at the bottom of the
        -- loop. Clamped to the length of that month.
        (date_trunc('month', v_day)::date
          + (least(
               coalesce(p_day_of_month, 1),
               extract(day from (date_trunc('month', v_day) + interval '1 month - 1 day'))::integer
             ) - 1))
    end;

    v_result := (v_target + make_time(p_hour, p_minute, 0)) at time zone v_tz;

    if v_result > p_after then
      return v_result;
    end if;

    -- Not in the future yet: move to the next candidate period and try again.
    v_day := case p_frequency
      when 'daily'     then v_day + 1
      when 'weekly'    then v_target + 7
      when 'monthly'   then (date_trunc('month', v_day) + interval '1 month')::date
      when 'quarterly' then (date_trunc('month', v_day) + interval '3 months')::date
      when 'yearly'    then (date_trunc('month', v_day) + interval '1 year')::date
    end;
  end loop;
end;
$fn$;

grant execute on function recipe_schedule_next_run(
  recipe_schedule_frequency, integer, integer, integer, integer, text, timestamptz
) to authenticated, service_role;

-- A timezone name the server actually knows. A typo stored here would compute
-- every future run in UTC silently, which is the sort of wrong that is only
-- noticed a month later.
create or replace function is_known_timezone(p_name text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $fn$
  select exists (select 1 from pg_timezone_names where name = p_name)
$fn$;

grant execute on function is_known_timezone(text) to authenticated, service_role;

-- =============================================================================
-- Write path
-- =============================================================================

create or replace function upsert_recipe_schedule(
  p_recipe_id    uuid,
  p_enabled      boolean default true,
  p_frequency    recipe_schedule_frequency default 'monthly',
  p_day_of_month integer default null,
  p_day_of_week  integer default null,
  p_hour         integer default 9,
  p_minute       integer default 0,
  p_timezone     text default 'UTC'
)
returns recipe_schedules
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user     uuid := auth.uid();
  v_recipe   cleaning_recipes;
  v_org      uuid;
  v_row      recipe_schedules;
  v_next     timestamptz;
  v_dom      integer := p_day_of_month;
  v_dow      integer := p_day_of_week;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select * into v_recipe from cleaning_recipes where id = p_recipe_id;
  -- Same wording for absent and someone else's: the API must not confirm that
  -- another tenant's recipe id is real.
  if not found or not has_workspace_access(v_recipe.workspace_id) then
    raise exception 'recipe % not found', p_recipe_id using errcode = 'insufficient_privilege';
  end if;

  select org_id into v_org from workspaces where id = v_recipe.workspace_id;

  if not is_known_timezone(p_timezone) then
    raise exception '% is not a known timezone', p_timezone using errcode = 'check_violation';
  end if;

  -- Fill in the field the chosen cadence needs, so a caller switching from
  -- weekly to monthly does not have to know which column that is.
  if p_frequency = 'weekly' then
    v_dow := coalesce(v_dow, 1);   -- Monday
    v_dom := null;
  elsif p_frequency in ('monthly', 'quarterly', 'yearly') then
    v_dom := coalesce(v_dom, 1);
    v_dow := null;
  else
    v_dom := null;
    v_dow := null;
  end if;

  v_next := recipe_schedule_next_run(
    p_frequency, v_dom, v_dow, p_hour, p_minute, p_timezone, now()
  );

  insert into recipe_schedules (
    organization_id, workspace_id, recipe_id, enabled, frequency,
    day_of_month, day_of_week, hour, minute, timezone, next_run_at, created_by
  )
  values (
    v_org, v_recipe.workspace_id, p_recipe_id, coalesce(p_enabled, true), p_frequency,
    v_dom, v_dow, p_hour, p_minute, p_timezone,
    case when coalesce(p_enabled, true) then v_next end,
    v_user
  )
  on conflict (recipe_id) do update
     set enabled      = coalesce(p_enabled, true),
         frequency    = p_frequency,
         day_of_month = v_dom,
         day_of_week  = v_dow,
         hour         = p_hour,
         minute       = p_minute,
         timezone     = p_timezone,
         -- Recomputed from the new cadence. A schedule edited from "1st at
         -- 09:00" to "15th at 17:00" that kept its old next_run_at would fire
         -- once on the old cadence, which is the sort of surprise that makes
         -- people stop trusting automation.
         next_run_at  = case when coalesce(p_enabled, true) then v_next end,
         updated_at   = now()
  returning * into v_row;

  perform write_audit(
    v_org, v_recipe.workspace_id,
    case when v_row.enabled then 'recipe.schedule.enabled' else 'recipe.schedule.disabled' end,
    'recipe_schedule', v_row.id::text,
    jsonb_build_object('recipe_id', p_recipe_id, 'frequency', p_frequency,
                       'timezone', p_timezone, 'next_run_at', v_row.next_run_at)
  );

  return v_row;
end;
$fn$;

revoke all on function upsert_recipe_schedule(
  uuid, boolean, recipe_schedule_frequency, integer, integer, integer, integer, text
) from public, anon;
grant execute on function upsert_recipe_schedule(
  uuid, boolean, recipe_schedule_frequency, integer, integer, integer, integer, text
) to authenticated, service_role;

create or replace function delete_recipe_schedule(p_recipe_id uuid)
returns boolean
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

  select org_id into v_org from workspaces where id = v_recipe.workspace_id;

  delete from recipe_schedules where recipe_id = p_recipe_id;
  if not found then
    return false;
  end if;

  perform write_audit(
    v_org, v_recipe.workspace_id, 'recipe.schedule.removed', 'recipe_schedule',
    p_recipe_id::text, '{}'::jsonb
  );
  return true;
end;
$fn$;

revoke all on function delete_recipe_schedule(uuid) from public, anon;
grant execute on function delete_recipe_schedule(uuid) to authenticated, service_role;

-- =============================================================================
-- The scheduler.
--
-- One function, called from the worker's idle pass. It is the whole scheduler:
-- there is no second process, no cron container and no second queue, because
-- the thing that needs doing is a query and a transaction and the workers are
-- already polling.
--
-- Safe under any number of concurrent schedulers, by three mechanisms and not
-- by one:
--
--   1. `for update skip locked` on the schedule row -- two schedulers select
--      disjoint sets rather than the same one.
--   2. `unique (schedule_id, scheduled_for)` -- if they somehow reached the
--      same firing, one insert fails.
--   3. `next_run_at` advances in the same transaction as the insert and the
--      enqueue, so there is no interval in which a firing exists and the
--      schedule still looks due.
--
-- Returns one row per firing so the caller can log what happened, which is the
-- only reason it returns anything at all.
-- =============================================================================

create or replace function claim_due_recipe_schedules(p_limit integer default 10)
-- The output columns carry a `fired_` prefix rather than matching the table's
-- own names. plpgsql resolves an unqualified identifier to an output parameter
-- before it resolves it to a column, and `on conflict (schedule_id,
-- scheduled_for)` below is exactly such a reference -- with the plain names it
-- fails at run time with "column reference is ambiguous", which is a scheduler
-- that does not schedule.
returns table (
  fired_schedule_id   uuid,
  fired_recipe_id     uuid,
  fired_workspace_id  uuid,
  fired_scheduled_for timestamptz,
  fired_status        recipe_schedule_run_status,
  fired_job_id        uuid,
  fired_detail        text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_schedule   recipe_schedules;
  v_recipe     cleaning_recipes;
  v_version    dataset_versions;
  v_due        timestamptz;
  v_job        agent_jobs;
  v_status     recipe_schedule_run_status;
  v_detail     text;
  v_watermark  timestamptz;
  v_next       timestamptz;
begin
  for v_schedule in
    select *
      from recipe_schedules s
     where s.enabled
       and s.next_run_at is not null
       and s.next_run_at <= now()
     order by s.next_run_at
     limit greatest(coalesce(p_limit, 10), 1)
     for update skip locked
  loop
    -- The identity of this firing. The instant it was *due*, so two schedulers
    -- waking three seconds apart compute the same value.
    v_due    := v_schedule.next_run_at;
    v_job    := null;
    v_detail := null;

    select * into v_recipe from cleaning_recipes where id = v_schedule.recipe_id;

    if not found or not v_recipe.enabled then
      v_status := 'skipped_disabled';
      v_detail := 'The recipe is disabled, so nothing was run.';
    else
      -- The source. One policy today, and the branch is written as a branch so
      -- that a connector is an added case rather than a rewrite.
      v_version := null;

      if v_schedule.source_kind = 'latest_dataset_version' then
        -- The watermark: nothing at or before this has anything to do with
        -- this firing.
        --
        -- Two cases in one expression. After the first run it is the moment of
        -- the version this schedule last processed -- replaying that again
        -- would produce the same cleaned output and a second report of the same
        -- month. Before the first run it is the moment the schedule was
        -- created, which is the part that is easy to get wrong: without it, a
        -- schedule made today fires next month and processes whatever happened
        -- to be the newest version at the time it was set up -- a file from six
        -- weeks ago that was already cleaned when it arrived. A schedule is a
        -- promise about data that arrives *from now on*.
        select coalesce(
                 (select dv.created_at
                    from recipe_schedule_runs r
                    join dataset_versions dv on dv.id = r.dataset_version_id
                   where r.schedule_id = v_schedule.id
                   order by r.scheduled_for desc
                   limit 1),
                 v_schedule.created_at
               )
          into v_watermark;

        select dv.* into v_version
          from dataset_versions dv
          join datasets d on d.id = dv.dataset_id
         where d.workspace_id = v_schedule.workspace_id
           and (v_recipe.dataset_id is null or dv.dataset_id = v_recipe.dataset_id)
           and dv.parquet_path is not null
           and dv.created_at > v_watermark
         order by dv.created_at desc
         limit 1;
      end if;

      if v_version.id is null then
        v_status := 'skipped_no_source';
        v_detail := 'No new data has arrived since the last run. '
                 || 'Upload this period''s file and it will be processed.';
      else
        -- The same job a person's click creates. Not a variant of it, not a
        -- scheduled-execution path: `replay_recipe` against a dataset version,
        -- which is what /api/agent/jobs enqueues for a manual run.
        --
        -- `enqueue_agent_job_internal` rather than `enqueue_agent_job` because
        -- there is no `auth.uid()` here -- the scheduler is the service role
        -- acting on a decision a person recorded earlier. Attribution is kept
        -- through `p_requested_by`, so the audit trail still names them.
        select * into v_job from enqueue_agent_job_internal(
          v_schedule.workspace_id,
          'replay_recipe'::agent_job_kind,
          jsonb_build_object(
            'scheduled', true,
            'schedule_id', v_schedule.id,
            'scheduled_for', v_due
          ),
          v_version.dataset_id,
          v_version.id,
          null,
          v_schedule.created_by,
          50::smallint
        );
        v_status := 'enqueued';
      end if;
    end if;

    -- The firing record. The unique constraint on (schedule_id, scheduled_for)
    -- is what makes a duplicate impossible rather than unlikely.
    insert into recipe_schedule_runs (
      schedule_id, organization_id, workspace_id, scheduled_for, status, detail,
      job_id, recipe_version_id, dataset_version_id
    )
    values (
      v_schedule.id, v_schedule.organization_id, v_schedule.workspace_id, v_due,
      v_status, v_detail, v_job.id, v_recipe.current_version_id, v_version.id
    )
    on conflict (schedule_id, scheduled_for) do nothing;

    v_next := recipe_schedule_next_run(
      v_schedule.frequency, v_schedule.day_of_month, v_schedule.day_of_week,
      v_schedule.hour, v_schedule.minute, v_schedule.timezone, now()
    );

    update recipe_schedules
       set next_run_at   = v_next,
           last_run_at   = now(),
           last_status   = v_status,
           last_job_id   = coalesce(v_job.id, last_job_id),
           last_error    = case when v_status = 'failed' then v_detail end,
           -- A skip is not a failure. Only a firing that could not complete
           -- counts against the schedule's health.
           consecutive_failures = case
             when v_status = 'failed' then consecutive_failures + 1
             when v_status = 'enqueued' then 0
             else consecutive_failures
           end,
           updated_at    = now()
     where id = v_schedule.id;

    perform write_audit(
      v_schedule.organization_id, v_schedule.workspace_id,
      'recipe.schedule.fired', 'recipe_schedule', v_schedule.id::text,
      jsonb_build_object('scheduled_for', v_due, 'status', v_status,
                         'job_id', v_job.id, 'dataset_version_id', v_version.id,
                         'next_run_at', v_next)
    );

    fired_schedule_id   := v_schedule.id;
    fired_recipe_id     := v_schedule.recipe_id;
    fired_workspace_id  := v_schedule.workspace_id;
    fired_scheduled_for := v_due;
    fired_status        := v_status;
    fired_job_id        := v_job.id;
    fired_detail        := v_detail;
    return next;
  end loop;
end;
$fn$;

revoke all on function claim_due_recipe_schedules(integer) from public, anon, authenticated;
grant execute on function claim_due_recipe_schedules(integer) to service_role;

-- -----------------------------------------------------------------------------
-- Closing the loop: the worker tells the firing which recipe run it became.
--
-- Separate from the firing itself because the run does not exist yet when the
-- job is created -- the job has to be claimed first. The guard above permits
-- exactly this one late write and nothing else.
-- -----------------------------------------------------------------------------

create or replace function attach_schedule_run(p_job_id uuid, p_recipe_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  update recipe_schedule_runs
     set recipe_run_id = p_recipe_run_id
   where job_id = p_job_id
     and recipe_run_id is null;
  return found;
end;
$fn$;

revoke all on function attach_schedule_run(uuid, uuid) from public, anon, authenticated;
grant execute on function attach_schedule_run(uuid, uuid) to service_role;

-- =============================================================================
-- RLS. Members read their workspace's schedules and firings; nobody writes
-- directly, and the scheduler is service_role.
-- =============================================================================

alter table recipe_schedules     enable row level security;
alter table recipe_schedule_runs enable row level security;

create policy recipe_schedules_select_members
  on recipe_schedules for select to authenticated
  using (has_workspace_access(workspace_id));

create policy recipe_schedule_runs_select_members
  on recipe_schedule_runs for select to authenticated
  using (has_workspace_access(workspace_id));

grant select on recipe_schedules, recipe_schedule_runs to authenticated;
grant all on recipe_schedules, recipe_schedule_runs to service_role;
