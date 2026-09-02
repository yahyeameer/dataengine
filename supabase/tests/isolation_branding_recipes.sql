-- =============================================================================
-- Tenant isolation for branding, recipes and generated reports.
--
-- The Python suite covers the rules a renderer follows; this covers the ones a
-- database enforces, which are the only ones that hold when application code is
-- wrong. It is a script rather than a test framework on purpose: it runs
-- against a real Postgres with the real migrations applied, and reads as a list
-- of sentences an auditor can check.
--
--   supabase db reset
--   psql "$(supabase status -o json | jq -r .DB_URL)" -f supabase/tests/isolation_branding_recipes.sql
--
-- Every line it prints starts with `ok` or `FAIL`. Run it on a scratch database:
-- it inserts two firms and three people and does not clean them up, because a
-- rollback at the end would also roll back the evidence.
-- =============================================================================

-- Tenant isolation for branding, recipes and reports, run against a real
-- Postgres with the real migrations applied. Every block that must fail is
-- wrapped so the script reports a verdict instead of aborting.

\set ON_ERROR_STOP on
\pset tuples_only on

-- Two firms, three people: an owner and a member in A, an owner in B.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'member-a@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'owner-b@example.com');

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme Accounting', 'acme', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Beta Books', 'beta', '33333333-3333-3333-3333-333333333333');

insert into organization_members (org_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'member'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'owner');

insert into workspaces (id, org_id, name, client_name, created_by) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Kentex', 'Kentex Cargo', '11111111-1111-1111-1111-111111111111'),
  ('dddddddd-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'Zenith', 'Zenith Ltd', '33333333-3333-3333-3333-333333333333');

create or replace function must_fail(sql text, label text) returns text
language plpgsql as $$
begin
  execute sql;
  return 'FAIL  ' || label || ' (it succeeded and should not have)';
exception when others then
  return 'ok    ' || label || ' -> ' || sqlerrm;
end;
$$;

create or replace function as_user(id text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', id, false);
end;
$$;

-- Two views that hand a signed-in caller an id they should not be able to use.
-- Without them the cross-tenant tests could only pass a random uuid, which
-- proves nothing: "no such recipe" is the right answer for an id that really
-- does not exist. These make the id real.
create view cleaning_recipes_all as select id from cleaning_recipes;
create view brand_asset_candidates_all as select id from brand_asset_candidates;
grant select on cleaning_recipes_all, brand_asset_candidates_all to authenticated;

-- ---------------------------------------------------------------------------
-- Branding: an owner may set it, a member may not.
-- ---------------------------------------------------------------------------
select as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;

select 'ok    owner sets branding -> ' || business_name
from upsert_organization_branding(
  'aaaaaaaa-0000-0000-0000-000000000001', 'Energy Gain', null, '#8a1538', 'energygain.example'
);

reset role;
select as_user('22222222-2222-2222-2222-222222222222');
set role authenticated;

select must_fail(
  $$select upsert_organization_branding('aaaaaaaa-0000-0000-0000-000000000001', 'Hijacked')$$,
  'a member may not change branding'
);

select case when count(*) = 1 then 'ok    a member can read their own branding'
            else 'FAIL  a member cannot read their own branding' end
from organization_branding;

-- ---------------------------------------------------------------------------
-- Cross-tenant: firm B can neither read nor write firm A's branding.
-- ---------------------------------------------------------------------------
reset role;
select as_user('33333333-3333-3333-3333-333333333333');
set role authenticated;

select case when count(*) = 0 then 'ok    firm B cannot read firm A branding'
            else 'FAIL  firm B READ firm A branding' end
from organization_branding
where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001';

select must_fail(
  $$select upsert_organization_branding('aaaaaaaa-0000-0000-0000-000000000001', 'Hijacked')$$,
  'firm B may not write firm A branding'
);

select must_fail(
  $$select clear_organization_logo('aaaaaaaa-0000-0000-0000-000000000001')$$,
  'firm B may not clear firm A logo'
);

-- ---------------------------------------------------------------------------
-- Logos: the storage path must live inside the organisation it belongs to.
-- ---------------------------------------------------------------------------
reset role;
select must_fail(
  $$select set_organization_logo(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'organizations/bbbbbbbb-0000-0000-0000-000000000002/branding/logo',
      'image/png', 240, 80, 5000)$$,
  'a logo path outside the organisation is refused'
);

select 'ok    a logo inside the organisation is accepted -> ' || logo_storage_path
from set_organization_logo(
  'aaaaaaaa-0000-0000-0000-000000000001',
  'organizations/aaaaaaaa-0000-0000-0000-000000000001/branding/logo',
  'image/png', 240, 80, 5000, '11111111-1111-1111-1111-111111111111'
);

select case when logo_url is null then 'ok    an uploaded logo clears a stale remote URL'
            else 'FAIL  the remote URL survived an upload' end
from organization_branding where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- Discovered images: approving one belonging to another tenant is not possible,
-- and the refusal does not confirm the id exists.
-- ---------------------------------------------------------------------------
select record_brand_asset_candidates(
  'aaaaaaaa-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000001',
  null,
  jsonb_build_array(jsonb_build_object(
    'storage_path', 'organizations/aaaaaaaa-0000-0000-0000-000000000001/branding/candidates/x',
    'source_name', 'image1.png', 'mime_type', 'image/png',
    'width', 240, 'height', 80, 'byte_size', 4200,
    'sha256', repeat('a', 64), 'score', 0.8, 'reasons', '["small"]'::jsonb, 'usable', true
  ))
) as candidates_recorded;

select as_user('33333333-3333-3333-3333-333333333333');
set role authenticated;

select case when count(*) = 0 then 'ok    firm B cannot see firm A candidates'
            else 'FAIL  firm B SAW firm A candidates' end
from brand_asset_candidates;

select must_fail(
  format($$select approve_brand_asset(%L)$$, (select id from brand_asset_candidates_all limit 1)),
  'firm B may not approve firm A candidate'
);

-- ---------------------------------------------------------------------------
-- Reports: written by the service role, readable only by the owning firm, and
-- immutable once written.
-- ---------------------------------------------------------------------------
reset role;
select 'ok    a report row records its branding snapshot -> ' || (branding_snapshot ->> 'business_name')
from record_report_artifact(
  'cccccccc-0000-0000-0000-000000000001', null, null, null, null, null,
  '[{"format":"pdf","ok":true,"path":"p"}]'::jsonb, 'exports', 'succeeded', null,
  '{"business_name":"Energy Gain","accent":"#8a1538"}'::jsonb, 'Monthly', 'September 2026', null
);

select must_fail(
  $$update report_artifacts set title = 'Rewritten'$$,
  'a generated report is immutable'
);

select as_user('33333333-3333-3333-3333-333333333333');
set role authenticated;
select case when count(*) = 0 then 'ok    firm B cannot read firm A reports'
            else 'FAIL  firm B READ firm A reports' end
from report_artifacts;

reset role;
select as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;
select case when count(*) = 1 then 'ok    firm A can read its own reports'
            else 'FAIL  firm A cannot read its own reports' end
from report_artifacts;

-- ---------------------------------------------------------------------------
-- Recipes: a version is immutable, an edit makes a new one, and firm B cannot
-- touch firm A's recipe.
-- ---------------------------------------------------------------------------
reset role;
select 'ok    captured recipe version ' || version_no
from capture_recipe(
  'cccccccc-0000-0000-0000-000000000001', null, 'sig-1', 'Monthly Shipment Analysis',
  '[{"id":"step_01","op":"normalize_whitespace","params":{"column":"customer"}}]'::jsonb,
  '[]'::jsonb, 'learned from August', null, '11111111-1111-1111-1111-111111111111'
);

select as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;

select 'ok    an edit writes version ' || version_no || ' with the deliverable attached'
from update_recipe_definition(
  (select id from cleaning_recipes limit 1),
  null, null, '{"formats":["pdf","xlsx"]}'::jsonb, 'add a workbook'
);

select case when count(*) = 2 then 'ok    both versions are kept'
            else 'FAIL  a version was replaced rather than added' end
from recipe_versions;

reset role;
select must_fail(
  $$update recipe_versions set steps = '[]'::jsonb$$,
  'a recipe version cannot be rewritten'
);

select as_user('33333333-3333-3333-3333-333333333333');
set role authenticated;

select case when count(*) = 0 then 'ok    firm B cannot read firm A recipes'
            else 'FAIL  firm B READ firm A recipes' end
from cleaning_recipes;

select must_fail(
  format($$select set_recipe_enabled(%L, false)$$, (select id from cleaning_recipes_all limit 1)),
  'firm B may not disable firm A recipe'
);

select must_fail(
  format($$select duplicate_recipe(%L)$$, (select id from cleaning_recipes_all limit 1)),
  'firm B may not duplicate firm A recipe'
);

reset role;
select 'ok    match_recipe now reports the deliverable -> ' || coalesce(report_config::text, 'null')
from match_recipe('cccccccc-0000-0000-0000-000000000001', 'sig-1');

drop view cleaning_recipes_all;
drop view brand_asset_candidates_all;
drop function must_fail(text, text);
drop function as_user(text);
