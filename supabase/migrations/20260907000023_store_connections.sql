-- =============================================================================
-- Connected stores.
--
-- A retailer or warehouse points this at the system they already keep their
-- books in -- a spreadsheet, a QuickBooks Online company, an Odoo instance --
-- and from then on the agent reads it on a schedule and reports revenue, costs
-- and profit for a day, a week, a month or a year.
--
-- Three things are worth reading before the DDL, because each of them is a
-- decision rather than a shape.
--
-- **The transactions do not live here.** A sync writes its rows as an ordinary
-- immutable `dataset_version` -- Parquet in the storage bucket, a parent
-- pointer, a row count, an audit line -- exactly as an uploaded workbook does.
-- These tables hold the *connection* and the *history of syncing it*, and
-- nothing a customer sold. That keeps a shop's daily takings out of the
-- database the dashboard queries with a user session, and it means a synced
-- ledger inherits versioning, questions, exports and the storage tenancy
-- boundary without a line of new code.
--
-- **Credentials are not in this table.** `store_connection_secrets` maps a
-- connection to a Supabase Vault secret id and has no RLS policy at all, so an
-- authenticated session cannot read it: absence of a policy is a deny. The
-- plaintext never sits in a normal table, the dashboard never receives it back
-- after it is written, and the worker reaches it through one function that
-- only `service_role` may execute.
--
-- **A schedule is a row, not a cron.** `store_report_schedules` names when the
-- next report is due; the worker sweeps it and enqueues the jobs. Putting the
-- clock in the database rather than on the agent host means a rebooted VPS
-- resumes the schedule instead of losing it, and two workers cannot both fire
-- the same weekly report because advancing `next_run_at` and enqueuing the job
-- happen in one transaction.
-- =============================================================================

create type store_source as enum ('excel', 'quickbooks', 'odoo');

create type store_sync_status as enum ('running', 'succeeded', 'failed');

create type store_report_cadence as enum ('daily', 'weekly', 'monthly', 'yearly');


-- -----------------------------------------------------------------------------
-- The connection.
-- -----------------------------------------------------------------------------

create table store_connections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations (id) on delete cascade,
  workspace_id       uuid not null references workspaces (id) on delete cascade,

  -- The dataset every sync of this connection writes a version into. Created
  -- with the connection and never reassigned, which is the whole point of one
  -- dataset per connection: August is version 4 of the same ledger that held
  -- July as version 3, so a month-on-month comparison is a parent hop rather
  -- than a join across two histories that happen to share a name.
  --
  -- Not-null rather than filled in by the first sync. A nullable column here
  -- would mean every reader carrying a branch for a state that exists for
  -- milliseconds, and a second sync racing the first to create the dataset.
  dataset_id         uuid not null references datasets (id) on delete cascade,

  name               text not null check (length(btrim(name)) between 1 and 200),
  source             store_source not null,

  -- active | paused | error. Text with a check rather than an enum: this
  -- vocabulary describes our own operational state and will move.
  status             text not null default 'active'
    check (status in ('active', 'paused', 'error')),

  -- Everything the connector needs that is *not* a credential: the Odoo address,
  -- database name and username; the QuickBooks realm id and whether it is a
  -- sandbox company; the sheet name and column map for a spreadsheet. Readable
  -- by the workspace's members, which is right -- these are settings a shop
  -- should be able to check and correct.
  config             jsonb not null default '{}'::jsonb,

  -- Reporting currency, and the second currency shown beside it.
  --
  -- USD is the default because Somali wholesale, import and most retail pricing
  -- is denominated in dollars and the shilling is quoted against it. The rate is
  -- stored with the date it was set, and both travel into every report's
  -- footnote: a converted figure whose basis is not stated is a number nobody
  -- can check.
  base_currency      text not null default 'USD' check (base_currency ~ '^[A-Z]{3,5}$'),
  secondary_currency text check (secondary_currency ~ '^[A-Z]{3,5}$'),
  secondary_rate     numeric(20, 6) check (secondary_rate > 0),
  rate_as_of         date,

  -- Which language the reports are written in.
  language           text not null default 'en' check (language in ('en', 'so')),

  -- Which weekday a week starts on, Monday 0 … Sunday 6. Saturday by default,
  -- because the working week here runs Saturday to Thursday and a Monday-start
  -- week splits it across two buckets -- so every week-on-week comparison would
  -- compare six trading days against five. Configurable because a warehouse
  -- serving international customers may genuinely run a Monday week.
  week_start         smallint not null default 5 check (week_start between 0 and 6),

  -- Stock, cash, receivables and short-term debts, for the zakat estimate. Held
  -- here rather than derived because none of the three sources exposes a stock
  -- valuation this system could trust, and zakat on trade is levied on assets
  -- rather than on profit -- so an estimate computed from the ledger alone would
  -- look authoritative and be wrong.
  balances           jsonb not null default '{}'::jsonb,

  last_sync_at       timestamptz,
  last_sync_status   store_sync_status,
  last_sync_error    text,

  created_by         uuid not null references auth.users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- A second currency is meaningless without a rate to reach it, and a rate is
  -- meaningless without the currency it converts to. Stated here so the pair
  -- cannot drift apart through a partial update.
  constraint store_connections_rate_ck check (
    (secondary_currency is null and secondary_rate is null)
    or (secondary_currency is not null and secondary_rate is not null)
  ),
  constraint store_connections_currency_ck check (secondary_currency <> base_currency)
);

create unique index store_connections_name_idx
  on store_connections (workspace_id, lower(btrim(name)));
create index store_connections_workspace_idx
  on store_connections (workspace_id, created_at desc);


-- -----------------------------------------------------------------------------
-- Credentials.
--
-- One row per connection that has any, holding a Vault secret id and never a
-- secret. There is deliberately no RLS policy on this table: absence of a
-- policy is a deny, so an authenticated session -- or a stolen publishable key
-- -- reads nothing here at all.
--
-- The id alone is inert without access to `vault.decrypted_secrets`, which
-- `authenticated` does not have. Keeping it in its own table rather than as a
-- column on `store_connections` means that stays true even if someone later
-- adds a broad select policy to the connection row.
-- -----------------------------------------------------------------------------

create table store_connection_secrets (
  connection_id uuid primary key references store_connections (id) on delete cascade,
  secret_id     uuid not null,
  updated_by    uuid references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- Sync history.
--
-- One row per attempt, including the failed ones. A shop asking "why is last
-- week missing" needs to see that Tuesday's sync failed, not an absence.
--
-- `entries_written` and `summary` carry what the connector reported about its
-- own reading -- how many records it read, how many it could not, and why -- so
-- "we read 1,204 of 1,231 lines" is answerable from a row rather than from a log
-- on a VPS.
-- -----------------------------------------------------------------------------

create table store_sync_runs (
  id                 uuid primary key default gen_random_uuid(),
  connection_id      uuid not null references store_connections (id) on delete cascade,
  workspace_id       uuid not null references workspaces (id) on delete cascade,
  job_id             uuid references agent_jobs (id) on delete set null,

  status             store_sync_status not null default 'running',
  window_start       date,
  window_end         date,

  entries_written    integer check (entries_written >= 0),
  dataset_version_id uuid references dataset_versions (id) on delete set null,
  summary            jsonb not null default '{}'::jsonb,
  error              text,

  started_at         timestamptz not null default now(),
  finished_at        timestamptz,

  constraint store_sync_runs_terminal_ck check (
    (status = 'running' and finished_at is null)
    or (status in ('succeeded', 'failed') and finished_at is not null)
  )
);

create index store_sync_runs_connection_idx
  on store_sync_runs (connection_id, started_at desc);


-- -----------------------------------------------------------------------------
-- Schedules.
--
-- `next_run_at` is the clock. It is advanced in the same transaction that
-- enqueues the job, which is what stops two workers firing the same weekly
-- report -- the second one finds a row that is no longer due.
-- -----------------------------------------------------------------------------

create table store_report_schedules (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references store_connections (id) on delete cascade,
  workspace_id  uuid not null references workspaces (id) on delete cascade,

  cadence       store_report_cadence not null,
  -- What the report covers, which is not the same as how often it arrives: a
  -- weekly email may report daily figures for the week just past.
  granularity   store_report_cadence not null default 'daily',
  -- md | pdf | docx | xlsx. Text rather than an enum because the renderer owns
  -- this list and a database migration to add a format would be coupling with
  -- no benefit.
  format        text not null default 'pdf'
    check (format in ('md', 'pdf', 'docx', 'xlsx')),
  language      text not null default 'en' check (language in ('en', 'so')),

  enabled       boolean not null default true,
  next_run_at   timestamptz not null default now(),
  last_run_at   timestamptz,
  last_job_id   uuid references agent_jobs (id) on delete set null,

  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),

  unique (connection_id, cadence)
);

create index store_report_schedules_due_idx
  on store_report_schedules (next_run_at) where enabled;


-- =============================================================================
-- RLS. The same shape as everywhere else: members read, nobody writes directly.
-- =============================================================================

alter table store_connections        enable row level security;
alter table store_connection_secrets enable row level security;
alter table store_sync_runs          enable row level security;
alter table store_report_schedules   enable row level security;

create policy store_connections_select_members
  on store_connections for select to authenticated
  using (has_workspace_access(workspace_id));

create policy store_sync_runs_select_members
  on store_sync_runs for select to authenticated
  using (has_workspace_access(workspace_id));

create policy store_report_schedules_select_members
  on store_report_schedules for select to authenticated
  using (has_workspace_access(workspace_id));

-- store_connection_secrets deliberately has no policy. See above.

grant select on
  store_connections, store_sync_runs, store_report_schedules
  to authenticated;

grant all on
  store_connections, store_connection_secrets, store_sync_runs, store_report_schedules
  to service_role;


-- =============================================================================
-- Writes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Creating a connection.
--
-- SECURITY DEFINER and membership re-checked from auth.uid(), so the database
-- authorises this independently of the route having got it right -- the same
-- discipline as `create_workspace` and `enqueue_agent_job`.
--
-- The config is stored as given but is never trusted to name a tenancy: the
-- org and workspace are derived from the workspace id, and every later use of
-- this row re-derives them the same way. A connection cannot be made to point
-- at another firm's data by what is written into its settings.
-- -----------------------------------------------------------------------------

create or replace function create_store_connection(
  p_workspace_id       uuid,
  p_name               text,
  p_source             store_source,
  p_config             jsonb default '{}'::jsonb,
  p_base_currency      text default 'USD',
  p_secondary_currency text default null,
  p_secondary_rate     numeric default null,
  p_language           text default 'en',
  p_week_start         smallint default 5
)
returns store_connections
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org        uuid;
  v_dataset    uuid;
  v_connection store_connections;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  if not has_workspace_access(p_workspace_id) then
    -- Reported as "not found" rather than "forbidden", so the API does not
    -- confirm that another firm's workspace id is real.
    raise exception 'workspace % not found', p_workspace_id
      using errcode = 'insufficient_privilege';
  end if;

  select org_id into v_org from workspaces where id = p_workspace_id;

  -- The ledger this connection accumulates into, opened here so the connection
  -- can never exist without one. `source_signature` is deliberately left null:
  -- it is how `parse_workbook` finds a recipe to replay, and a synced ledger
  -- has no recipe -- its shape is fixed by the connector, not learned from a
  -- customer's spreadsheet.
  -- Truncated before the suffix: `datasets.name` allows 200 characters and so
  -- does the connection's, so a store named right up to the limit would fail
  -- the dataset's own check on a suffix it never asked for.
  insert into datasets (workspace_id, name, created_by)
  values (p_workspace_id, left(btrim(p_name), 180) || ' — ledger', auth.uid())
  returning id into v_dataset;

  insert into store_connections (
    org_id, workspace_id, dataset_id, name, source, config,
    base_currency, secondary_currency, secondary_rate,
    rate_as_of, language, week_start, created_by
  )
  values (
    v_org, p_workspace_id, v_dataset, btrim(p_name), p_source, coalesce(p_config, '{}'::jsonb),
    upper(coalesce(p_base_currency, 'USD')),
    nullif(upper(coalesce(p_secondary_currency, '')), ''),
    p_secondary_rate,
    case when p_secondary_rate is not null then current_date end,
    coalesce(p_language, 'en'), coalesce(p_week_start, 5::smallint),
    auth.uid()
  )
  returning * into v_connection;

  perform write_audit(
    v_org, p_workspace_id, 'store.connection.created', 'store_connection',
    v_connection.id::text,
    jsonb_build_object('name', v_connection.name, 'source', p_source, 'dataset_id', v_dataset)
  );

  return v_connection;
end;
$fn$;


-- -----------------------------------------------------------------------------
-- Changing a connection's settings.
--
-- Deliberately narrow. The source cannot be changed and neither can the
-- dataset: a connection that switched from Excel to Odoo halfway through would
-- keep appending to a version chain whose earlier entries came from somewhere
-- else, and every month-on-month comparison across that boundary would be
-- comparing two different things while looking like one.
-- -----------------------------------------------------------------------------

create or replace function update_store_connection(
  p_connection_id      uuid,
  p_name               text default null,
  p_config             jsonb default null,
  p_status             text default null,
  p_secondary_currency text default null,
  p_secondary_rate     numeric default null,
  p_language           text default null,
  p_week_start         smallint default null,
  p_balances           jsonb default null
)
returns store_connections
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_connection store_connections;
begin
  select * into v_connection from store_connections where id = p_connection_id;
  if v_connection.id is null or not has_workspace_access(v_connection.workspace_id) then
    raise exception 'store connection % not found', p_connection_id
      using errcode = 'insufficient_privilege';
  end if;

  update store_connections
     set name               = coalesce(nullif(btrim(p_name), ''), name),
         config             = coalesce(p_config, config),
         status             = coalesce(p_status, status),
         secondary_currency = case
                                when p_secondary_currency is null then secondary_currency
                                else nullif(upper(btrim(p_secondary_currency)), '')
                              end,
         secondary_rate     = case
                                when p_secondary_rate is null then secondary_rate
                                else p_secondary_rate
                              end,
         -- The rate's date moves only when the rate does. A shop that edits its
         -- shop name must not silently restamp the exchange rate its last
         -- report was footnoted with.
         rate_as_of         = case
                                when p_secondary_rate is null then rate_as_of
                                else current_date
                              end,
         language           = coalesce(p_language, language),
         week_start         = coalesce(p_week_start, week_start),
         balances           = coalesce(p_balances, balances),
         updated_at         = now()
   where id = p_connection_id
  returning * into v_connection;

  perform write_audit(
    v_connection.org_id, v_connection.workspace_id, 'store.connection.updated',
    'store_connection', v_connection.id::text,
    -- Which settings moved, by name. The values are not recorded: they are on
    -- the row, and an audit entry that repeats an exchange rate on every edit
    -- is a log people stop reading.
    jsonb_build_object(
      'fields', (
        select coalesce(jsonb_agg(field), '[]'::jsonb)
        from unnest(array[
          case when p_name is not null then 'name' end,
          case when p_config is not null then 'config' end,
          case when p_status is not null then 'status' end,
          case when p_secondary_currency is not null then 'secondary_currency' end,
          case when p_secondary_rate is not null then 'secondary_rate' end,
          case when p_language is not null then 'language' end,
          case when p_week_start is not null then 'week_start' end,
          case when p_balances is not null then 'balances' end
        ]) as field
        where field is not null
      )
    )
  );

  return v_connection;
end;
$fn$;


-- -----------------------------------------------------------------------------
-- Storing a credential.
--
-- The secret goes into Supabase Vault and its id into `store_connection_secrets`.
-- Nothing here writes the plaintext to a table, and nothing anywhere reads it
-- back to a browser: `store_connection_credentials` below is the only way out
-- and only `service_role` may execute it.
--
-- The audit row records that a credential was set and by whom, and carries no
-- part of it -- not a prefix, not a length. A redacted secret in an append-only
-- log is still a secret in an append-only log.
-- -----------------------------------------------------------------------------

create or replace function set_store_connection_secret(
  p_connection_id uuid,
  p_secret        text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_connection store_connections;
  v_existing   uuid;
  v_secret_id  uuid;
begin
  select * into v_connection from store_connections where id = p_connection_id;
  if v_connection.id is null or not has_workspace_access(v_connection.workspace_id) then
    raise exception 'store connection % not found', p_connection_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_secret is null or btrim(p_secret) = '' then
    raise exception 'a credential cannot be empty';
  end if;

  if to_regnamespace('vault') is null then
    raise exception
      'Supabase Vault is not enabled on this project, so credentials cannot be stored '
      'safely. Enable it before connecting a QuickBooks or Odoo store.';
  end if;

  select secret_id into v_existing
  from store_connection_secrets where connection_id = p_connection_id;

  if v_existing is null then
    select vault.create_secret(
      p_secret,
      'store_connection:' || p_connection_id::text,
      'Credentials for store connection ' || v_connection.name
    ) into v_secret_id;

    insert into store_connection_secrets (connection_id, secret_id, updated_by)
    values (p_connection_id, v_secret_id, auth.uid());
  else
    perform vault.update_secret(v_existing, p_secret);
    update store_connection_secrets
       set updated_by = auth.uid(), updated_at = now()
     where connection_id = p_connection_id;
    v_secret_id := v_existing;
  end if;

  perform write_audit(
    v_connection.org_id, v_connection.workspace_id, 'store.connection.secret_set',
    'store_connection', p_connection_id::text,
    jsonb_build_object('rotated', v_existing is not null)
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- Rotating a credential the provider replaced. Worker only.
--
-- QuickBooks issues a new refresh token on every refresh and expires the old
-- one, so a connector that ignores the replacement works for exactly one cycle
-- and then locks the customer out with an error that looks like a problem on
-- their side. The worker has no user session, so it cannot go through
-- `set_store_connection_secret`, and this is the narrow path it uses instead.
--
-- Narrow in two ways: it will not *create* a credential, only replace one that
-- already exists -- so this function cannot be used to attach a credential to a
-- connection that had none -- and it audits under its own action, with
-- `rotated_by` naming the agent rather than leaving a null that reads like a
-- person who forgot to sign.
-- -----------------------------------------------------------------------------

create or replace function rotate_store_connection_secret(
  p_connection_id uuid,
  p_secret        text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_connection store_connections;
  v_secret_id  uuid;
begin
  if p_secret is null or btrim(p_secret) = '' then
    raise exception 'a rotated credential cannot be empty';
  end if;

  select * into v_connection from store_connections where id = p_connection_id;
  if v_connection.id is null then
    raise exception 'store connection % not found', p_connection_id;
  end if;

  select secret_id into v_secret_id
  from store_connection_secrets where connection_id = p_connection_id;

  if v_secret_id is null then
    raise exception 'store connection % has no credential to rotate', p_connection_id;
  end if;

  perform vault.update_secret(v_secret_id, p_secret);

  update store_connection_secrets
     set updated_at = now()
   where connection_id = p_connection_id;

  perform write_audit(
    v_connection.org_id, v_connection.workspace_id, 'store.connection.secret_rotated',
    'store_connection', p_connection_id::text,
    jsonb_build_object('rotated_by', 'agent', 'reason', 'the provider issued a replacement')
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- Reading a credential. Worker only.
--
-- Returns the connection's settings *and* its decrypted secret in one call,
-- because the worker needs both and two calls would mean two chances to fetch
-- the settings of one connection and the credential of another.
-- -----------------------------------------------------------------------------

create or replace function store_connection_credentials(p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_connection store_connections;
  v_secret_id  uuid;
  v_secret     text := null;
begin
  select * into v_connection from store_connections where id = p_connection_id;
  if v_connection.id is null then
    raise exception 'store connection % not found', p_connection_id;
  end if;

  select secret_id into v_secret_id
  from store_connection_secrets where connection_id = p_connection_id;

  if v_secret_id is not null and to_regnamespace('vault') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where id = $1'
      into v_secret using v_secret_id;
  end if;

  return jsonb_build_object(
    'id', v_connection.id,
    'org_id', v_connection.org_id,
    'workspace_id', v_connection.workspace_id,
    'dataset_id', v_connection.dataset_id,
    'name', v_connection.name,
    'source', v_connection.source,
    'status', v_connection.status,
    'config', v_connection.config,
    'base_currency', v_connection.base_currency,
    'secondary_currency', v_connection.secondary_currency,
    'secondary_rate', v_connection.secondary_rate,
    'rate_as_of', v_connection.rate_as_of,
    'language', v_connection.language,
    'week_start', v_connection.week_start,
    'balances', v_connection.balances,
    'created_by', v_connection.created_by,
    'secret', v_secret
  );
end;
$fn$;


-- -----------------------------------------------------------------------------
-- Sync runs.
--
-- Two functions rather than one update, so a run that starts is always visible
-- even if the worker dies mid-fetch. A row stuck in `running` is a diagnosable
-- fact; a sync that left no trace is not.
-- -----------------------------------------------------------------------------

create or replace function start_store_sync(
  p_connection_id uuid,
  p_job_id        uuid default null,
  p_window_start  date default null,
  p_window_end    date default null
)
returns store_sync_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_connection store_connections;
  v_run        store_sync_runs;
begin
  select * into v_connection from store_connections where id = p_connection_id;
  if v_connection.id is null then
    raise exception 'store connection % not found', p_connection_id;
  end if;

  insert into store_sync_runs (
    connection_id, workspace_id, job_id, window_start, window_end
  )
  values (p_connection_id, v_connection.workspace_id, p_job_id, p_window_start, p_window_end)
  returning * into v_run;

  return v_run;
end;
$fn$;


create or replace function finish_store_sync(
  p_run_id             uuid,
  p_status             store_sync_status,
  p_entries_written    integer default null,
  p_dataset_version_id uuid default null,
  p_summary            jsonb default '{}'::jsonb,
  p_error              text default null
)
returns store_sync_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_run        store_sync_runs;
  v_connection store_connections;
begin
  update store_sync_runs
     set status             = p_status,
         entries_written    = p_entries_written,
         dataset_version_id = p_dataset_version_id,
         summary            = coalesce(p_summary, '{}'::jsonb),
         error              = p_error,
         finished_at        = now()
   where id = p_run_id and status = 'running'
  returning * into v_run;

  if v_run.id is null then
    raise exception 'sync run % is not running', p_run_id;
  end if;

  -- The connection carries the last verdict so the dashboard can show "last
  -- synced 3 hours ago, failed" without reading the run history. `status` moves
  -- to 'error' on a failure and back on the next success, so a shop whose
  -- credentials expired is visibly broken rather than merely quiet.
  update store_connections
     set last_sync_at     = now(),
         last_sync_status = p_status,
         last_sync_error  = p_error,
         status           = case
                              when p_status = 'failed' then 'error'
                              when status = 'error' then 'active'
                              else status
                            end,
         updated_at       = now()
   where id = v_run.connection_id
  returning * into v_connection;

  perform write_audit(
    v_connection.org_id, v_connection.workspace_id, 'store.sync.finished',
    'store_connection', v_connection.id::text,
    jsonb_build_object(
      'run_id', v_run.id,
      'status', p_status,
      'entries', p_entries_written,
      'dataset_version_id', p_dataset_version_id
    )
  );

  return v_run;
end;
$fn$;


-- -----------------------------------------------------------------------------
-- Schedules.
-- -----------------------------------------------------------------------------

create or replace function set_store_report_schedule(
  p_connection_id uuid,
  p_cadence       store_report_cadence,
  p_granularity   store_report_cadence default null,
  p_format        text default 'pdf',
  p_language      text default null,
  p_enabled       boolean default true
)
returns store_report_schedules
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_connection store_connections;
  v_schedule   store_report_schedules;
begin
  select * into v_connection from store_connections where id = p_connection_id;
  if v_connection.id is null or not has_workspace_access(v_connection.workspace_id) then
    raise exception 'store connection % not found', p_connection_id
      using errcode = 'insufficient_privilege';
  end if;

  insert into store_report_schedules (
    connection_id, workspace_id, cadence, granularity, format, language, enabled,
    next_run_at, created_by
  )
  values (
    p_connection_id, v_connection.workspace_id, p_cadence,
    coalesce(p_granularity, case p_cadence
                              when 'daily' then 'daily'
                              when 'weekly' then 'daily'
                              when 'monthly' then 'weekly'
                              else 'monthly'
                            end::store_report_cadence),
    coalesce(p_format, 'pdf'),
    coalesce(p_language, v_connection.language),
    coalesce(p_enabled, true),
    now(),
    auth.uid()
  )
  on conflict (connection_id, cadence) do update
    set granularity = excluded.granularity,
        format      = excluded.format,
        language    = excluded.language,
        enabled     = excluded.enabled
  returning * into v_schedule;

  perform write_audit(
    v_connection.org_id, v_connection.workspace_id, 'store.schedule.set',
    'store_connection', p_connection_id::text,
    jsonb_build_object('cadence', p_cadence, 'enabled', v_schedule.enabled)
  );

  return v_schedule;
end;
$fn$;


-- -----------------------------------------------------------------------------
-- The sweep.
--
-- Called by the worker on a timer. Everything about one schedule happens in one
-- statement's transaction: the row is locked, the jobs are enqueued and
-- `next_run_at` moves forward together, so two workers sweeping at the same
-- moment cannot both fire the same weekly report. The second finds a row that
-- is no longer due.
--
-- `skip locked` rather than a wait, because a schedule another worker is
-- already handling needs no second opinion.
--
-- Two jobs are enqueued per due schedule, not one. The sync must finish before
-- the report can read what it wrote, and `store_financials` handles that by
-- waiting for the version rather than by this function guessing a delay --
-- see `handle_store_financials`.
-- -----------------------------------------------------------------------------

create or replace function enqueue_due_store_reports(p_limit integer default 20)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row      record;
  v_sync     agent_jobs;
  v_report   agent_jobs;
  v_count    integer := 0;
begin
  for v_row in
    select s.*, c.status as connection_status, c.created_by as connection_owner
    from store_report_schedules s
    join store_connections c on c.id = s.connection_id
    where s.enabled
      and s.next_run_at <= now()
      and c.status <> 'paused'
    order by s.next_run_at
    limit greatest(coalesce(p_limit, 20), 1)
    for update of s skip locked
  loop
    v_sync := enqueue_agent_job_internal(
      v_row.workspace_id,
      'sync_store'::agent_job_kind,
      jsonb_build_object('connection_id', v_row.connection_id, 'scheduled', true),
      null, null, null,
      -- Attributed to whoever set the connection up, so the audit trail names a
      -- person rather than "the system" for work that person asked for.
      v_row.connection_owner,
      120::smallint
    );

    v_report := enqueue_agent_job_internal(
      v_row.workspace_id,
      'store_financials'::agent_job_kind,
      jsonb_build_object(
        'connection_id', v_row.connection_id,
        'granularity', v_row.granularity,
        'cadence', v_row.cadence,
        'format', v_row.format,
        'language', v_row.language,
        'after_job_id', v_sync.id,
        'scheduled', true
      ),
      null, null, null, v_row.connection_owner, 130::smallint
    );

    update store_report_schedules
       set last_run_at = now(),
           last_job_id = v_report.id,
           next_run_at = case cadence
                           when 'daily'   then now() + interval '1 day'
                           when 'weekly'  then now() + interval '7 days'
                           when 'monthly' then now() + interval '1 month'
                           else now() + interval '1 year'
                         end
     where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$fn$;


-- -----------------------------------------------------------------------------
-- Privileges.
--
-- The customer-facing functions go to `authenticated` and re-check membership
-- from auth.uid() themselves. The four the worker uses go to `service_role`
-- alone and are unreachable from a browser session, which matters most for
-- `store_connection_credentials`: it is the one function in this feature that
-- can return a secret.
-- -----------------------------------------------------------------------------

revoke all on function create_store_connection(uuid, text, store_source, jsonb, text, text, numeric, text, smallint)
  from public, anon;
grant execute on function create_store_connection(uuid, text, store_source, jsonb, text, text, numeric, text, smallint)
  to authenticated;

revoke all on function update_store_connection(uuid, text, jsonb, text, text, numeric, text, smallint, jsonb)
  from public, anon;
grant execute on function update_store_connection(uuid, text, jsonb, text, text, numeric, text, smallint, jsonb)
  to authenticated;

revoke all on function set_store_connection_secret(uuid, text) from public, anon;
grant execute on function set_store_connection_secret(uuid, text) to authenticated;

revoke all on function set_store_report_schedule(uuid, store_report_cadence, store_report_cadence, text, text, boolean)
  from public, anon;
grant execute on function set_store_report_schedule(uuid, store_report_cadence, store_report_cadence, text, text, boolean)
  to authenticated;

revoke all on function store_connection_credentials(uuid) from public, anon, authenticated;
grant execute on function store_connection_credentials(uuid) to service_role;

revoke all on function rotate_store_connection_secret(uuid, text) from public, anon, authenticated;
grant execute on function rotate_store_connection_secret(uuid, text) to service_role;

revoke all on function start_store_sync(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function start_store_sync(uuid, uuid, date, date) to service_role;

revoke all on function finish_store_sync(uuid, store_sync_status, integer, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function finish_store_sync(uuid, store_sync_status, integer, uuid, jsonb, text)
  to service_role;

revoke all on function enqueue_due_store_reports(integer) from public, anon, authenticated;
grant execute on function enqueue_due_store_reports(integer) to service_role;
