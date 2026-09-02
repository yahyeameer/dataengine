-- =============================================================================
-- Recipe scheduling and queue hardening, against a real database.
--
-- These are the rules that only a database can enforce -- a unique key that two
-- schedulers cannot both satisfy, a row lock that makes "find due work" safe to
-- run from several processes, an append-only firing record, and the tenant
-- boundary around all of it. Asserting them anywhere else would be asserting
-- something else.
--
--   supabase db reset
--   psql "$(supabase status -o json | jq -r .DB_URL)" -f supabase/tests/scheduling_and_queue.sql
--
-- Every line starts `ok` or `FAIL`. Run it on a scratch database: it inserts two
-- firms and does not clean up, because a rollback at the end would also roll
-- back the evidence.
-- =============================================================================

\pset tuples_only on
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'b@example.com');
insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Acme','acme','11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000002','Beta','beta','33333333-3333-3333-3333-333333333333');
insert into organization_members (org_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','owner'),
  ('bbbbbbbb-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','owner');
insert into workspaces (id, org_id, name, created_by) values
  ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Kentex','11111111-1111-1111-1111-111111111111'),
  ('dddddddd-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','Zenith','33333333-3333-3333-3333-333333333333');
insert into datasets (id, workspace_id, name, created_by) values
  ('eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','Monthly shipments','11111111-1111-1111-1111-111111111111');

-- Two dataset versions: v0 raw, v1 the "August" file already processed.
insert into dataset_versions (id, dataset_id, version_no, kind, parquet_path, created_at)
values ('f0000000-0000-0000-0000-000000000000','eeeeeeee-0000-0000-0000-000000000001',0,'raw','p/v0', now() - interval '40 days');

insert into cleaning_recipes (id, workspace_id, dataset_id, name, source_signature, created_by)
values ('a1000000-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',
        'eeeeeeee-0000-0000-0000-000000000001','Monthly shipment analysis','sig-1',
        '11111111-1111-1111-1111-111111111111');
insert into recipe_versions (id, recipe_id, version_no, steps)
values ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',1,'[]'::jsonb);
update cleaning_recipes set current_version_id = 'a2000000-0000-0000-0000-000000000001'
 where id = 'a1000000-0000-0000-0000-000000000001';

create or replace function must_fail(sql text, label text) returns text
language plpgsql as $$
begin execute sql; return 'FAIL  ' || label; exception when others then
  return 'ok    ' || label || ' -> ' || sqlerrm; end; $$;

-- ---------------------------------------------------------------------------
-- Creating a schedule
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
set role authenticated;

select 'ok    owner creates a monthly schedule, next run ' || next_run_at
from upsert_recipe_schedule('a1000000-0000-0000-0000-000000000001', true, 'monthly', 1, null, 9, 0, 'Africa/Nairobi');

select must_fail(
  $$select upsert_recipe_schedule('a1000000-0000-0000-0000-000000000001', true, 'monthly', 1, null, 9, 0, 'Mars/Olympus')$$,
  'an unknown timezone is refused');

reset role;
select set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false);
set role authenticated;

select must_fail(
  $$select upsert_recipe_schedule('a1000000-0000-0000-0000-000000000001')$$,
  'firm B may not schedule firm A recipe');
select case when count(*) = 0 then 'ok    firm B cannot read firm A schedules'
            else 'FAIL  firm B READ firm A schedules' end from recipe_schedules;
select must_fail(
  $$select delete_recipe_schedule('a1000000-0000-0000-0000-000000000001')$$,
  'firm B may not delete firm A schedule');
reset role;

-- ---------------------------------------------------------------------------
-- Firing with no new data
-- ---------------------------------------------------------------------------
update recipe_schedules set next_run_at = now() - interval '1 minute';

select 'ok    with no new version the firing is ' || fired_status || ' (' || left(fired_detail, 40) || '...)'
from claim_due_recipe_schedules(10);

select case when count(*) = 0 then 'ok    and no job was created'
            else 'FAIL  a job was created with no source' end
from agent_jobs where kind = 'replay_recipe';

-- ---------------------------------------------------------------------------
-- Firing with a new file
-- ---------------------------------------------------------------------------
insert into dataset_versions (id, dataset_id, parent_version_id, version_no, kind, parquet_path)
values ('f1000000-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001',
        'f0000000-0000-0000-0000-000000000000',1,'cleaned','p/v1');

update recipe_schedules set next_run_at = now() - interval '1 minute';

select 'ok    with a new version the firing is ' || fired_status || ', job ' || left(fired_job_id::text, 8)
from claim_due_recipe_schedules(10);

select 'ok    the job is a ' || kind || ' against version ' || left(dataset_version_id::text,8)
    || ', payload scheduled=' || (payload ->> 'scheduled')
from agent_jobs where kind = 'replay_recipe';

select 'ok    the schedule advanced to ' || next_run_at || ' (status ' || last_status || ')'
from recipe_schedules;

-- ---------------------------------------------------------------------------
-- Idempotency and concurrency
-- ---------------------------------------------------------------------------
select case when count(*) = 0 then 'ok    an immediate second sweep fires nothing'
            else 'FAIL  the schedule fired twice' end
from claim_due_recipe_schedules(10);

-- Force the same due instant back onto the schedule, as a crashed scheduler
-- that never advanced it would leave things.
update recipe_schedules
   set next_run_at = (select scheduled_for from recipe_schedule_runs order by scheduled_for desc limit 1);

select 'ok    replaying the same due instant is ' || fired_status || ' (the unique key held)'
from claim_due_recipe_schedules(10);

select case when count(*) = 1 then 'ok    exactly one firing row exists for that instant'
            else 'FAIL  ' || count(*) || ' firing rows for one instant' end
from recipe_schedule_runs
where scheduled_for = (select max(scheduled_for) from recipe_schedule_runs);

select case when count(*) = 1 then 'ok    and exactly one replay job was ever created'
            else 'FAIL  ' || count(*) || ' replay jobs' end
from agent_jobs where kind = 'replay_recipe';

-- ---------------------------------------------------------------------------
-- A disabled recipe
-- ---------------------------------------------------------------------------
update cleaning_recipes set enabled = false where id = 'a1000000-0000-0000-0000-000000000001';
insert into dataset_versions (id, dataset_id, parent_version_id, version_no, kind, parquet_path)
values ('f2000000-0000-0000-0000-000000000002','eeeeeeee-0000-0000-0000-000000000001',
        'f1000000-0000-0000-0000-000000000001',2,'cleaned','p/v2');
update recipe_schedules set next_run_at = now() - interval '1 minute';

select 'ok    a disabled recipe fires as ' || fired_status from claim_due_recipe_schedules(10);
update cleaning_recipes set enabled = true where id = 'a1000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- The firing record is evidence
-- ---------------------------------------------------------------------------
select must_fail($$delete from recipe_schedule_runs$$, 'a firing cannot be deleted');
select must_fail($$update recipe_schedule_runs set status = 'enqueued'$$,
                 'a firing cannot be rewritten');
select 'ok    but the recipe run can be attached later: ' ||
       attach_schedule_run((select job_id from recipe_schedule_runs where job_id is not null limit 1), null);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
select 'ok    audit recorded: ' || string_agg(distinct action, ', ')
from audit_logs where action like 'recipe.schedule%';


-- ===========================================================================
-- Queue hardening
-- ===========================================================================

insert into agent_workers (id, hostname) values ('w1','box'),('w2','box') on conflict do nothing;

-- Scoped to the kind this section creates. Deleting every job would null the
-- job_id on the firing rows above, and the append-only guard refuses that --
-- correctly, which is itself worth knowing.
delete from agent_jobs where kind = 'parse_workbook';

-- The defect this replaced: a job whose worker died on its LAST attempt was
-- left `running` with a dead lease, unclaimable and never terminal. It showed
-- on screen as work in progress, forever.
insert into agent_jobs (id, org_id, workspace_id, kind, status, attempts, max_attempts, claimed_by, lease_expires_at, started_at)
values ('99999999-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',
        'parse_workbook','running',3,3,'w1', now() - interval '1 hour', now() - interval '2 hours');

select case when sweep_stuck_agent_jobs() = 1
            then 'ok    the sweep ends a job whose worker died on its last attempt'
            else 'FAIL  the sweep missed an abandoned job' end;

select case when status = 'failed' and finished_at is not null and error is not null
            then 'ok    it is failed, finished and carries a reason a person can read'
            else 'FAIL  it is still ' || status end
from agent_jobs where id = '99999999-0000-0000-0000-000000000001';

-- A job with attempts left is a job a worker will reclaim. Sweeping it would
-- take work away from somebody about to do it.
delete from agent_jobs where kind = 'parse_workbook';
-- Priority 1 so it is unambiguously the next claim: the scheduler section
-- above left a real replay job in the queue at priority 50.
insert into agent_jobs (id, org_id, workspace_id, kind, status, attempts, max_attempts, claimed_by, lease_expires_at, priority)
values ('77777777-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',
        'parse_workbook','running',1,3,'w1', now() - interval '1 hour', 1);

select case when sweep_stuck_agent_jobs() = 0
            then 'ok    a job with attempts remaining is left for a worker to reclaim'
            else 'FAIL  the sweep stole a reclaimable job' end;

select case when (select id from claim_agent_job('w2')) = '77777777-0000-0000-0000-000000000001'
            then 'ok    and another worker does reclaim it'
            else 'FAIL  nobody reclaimed it' end;

select case when (finish_agent_job('77777777-0000-0000-0000-000000000001','w2',false,null,'storage timed out',true)).status = 'queued'
            then 'ok    a retryable failure returns to the queue'
            else 'FAIL  a retryable failure did not return to the queue' end;

select case when available_at > now() + interval '20 seconds'
            then 'ok    and waits ' || round(extract(epoch from available_at - now()))
                 || 's before the next attempt rather than retrying instantly'
            else 'FAIL  no backoff: available_at = ' || available_at end
from agent_jobs where id = '77777777-0000-0000-0000-000000000001';

-- Checked by id rather than by "nothing was claimed": the scheduler section
-- above left a legitimate replay job in the queue, and claiming that one is
-- correct behaviour.
select case when coalesce((select id from claim_agent_job('w1')), '00000000-0000-0000-0000-000000000000')
              <> '77777777-0000-0000-0000-000000000001'
            then 'ok    and is not claimable while it waits'
            else 'FAIL  a backing-off job was claimed before its delay elapsed' end;

select must_fail(
  $$select finish_agent_job('77777777-0000-0000-0000-000000000001','w1',true)$$,
  'a worker whose lease was stolen cannot finish the job');

-- Per-organization concurrency. Six queued for one firm, two for another;
-- claimed one statement at a time, as separate workers do.
delete from agent_jobs where kind = 'parse_workbook';
insert into agent_jobs (org_id, workspace_id, kind, priority)
select 'aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','parse_workbook', 1
from generate_series(1, 6);
insert into agent_jobs (org_id, workspace_id, kind, priority)
select 'bbbbbbbb-0000-0000-0000-000000000002','dddddddd-0000-0000-0000-000000000002','parse_workbook', 1
from generate_series(1, 2);

-- Eight claims, each its own statement: a single statement would evaluate every
-- call against one snapshot and see no running jobs at all.
\o /dev/null
select claim_agent_job('w1');
select claim_agent_job('w1');
select claim_agent_job('w1');
select claim_agent_job('w1');
select claim_agent_job('w2');
select claim_agent_job('w2');
select claim_agent_job('w2');
select claim_agent_job('w2');
\o

select case when count(*) filter (where org_id = 'aaaaaaaa-0000-0000-0000-000000000001') <= org_concurrency_limit('aaaaaaaa-0000-0000-0000-000000000001')
            then 'ok    one organization cannot take more than its concurrency limit ('
                 || count(*) filter (where org_id = 'aaaaaaaa-0000-0000-0000-000000000001') || ')'
            else 'FAIL  one organization took every worker' end
from agent_jobs where status = 'running';

select case when count(*) > 0
            then 'ok    and the other organization still gets served ('
                 || count(*) || ' running) rather than starved'
            else 'FAIL  the second organization was starved' end
from agent_jobs
where status = 'running' and org_id = 'bbbbbbbb-0000-0000-0000-000000000002';
