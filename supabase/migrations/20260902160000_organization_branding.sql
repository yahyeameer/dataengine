-- =============================================================================
-- Organization branding: whose name and whose logo go on a report.
--
-- The report engine already drew a brand. What it had no way to answer was
-- *whose*, because nothing stored one -- `_brand_for` read an override off the
-- job payload and fell back to the `organizations` row, which is the accounting
-- firm rather than the business the report is about. Its own comment called the
-- payload path "a deliberate first cut ... when the screen exists it writes
-- into the same three fields". This is that screen's table, and it is those
-- three fields plus the logo the first cut had nowhere to put.
--
-- One row per organization, not per workspace. A firm has one identity; a
-- client workspace inherits it. Per-client branding is a real requirement and a
-- later one, and the shape here does not stand in its way: a workspace-level
-- override becomes a nullable column set or a second table keyed on
-- workspace_id, and the resolution order in `branding.py` already has the slot
-- for it.
--
-- No new "organization settings" table was invented for this. There is no
-- existing one to extend -- `organizations` carries id, name, slug and
-- attribution and nothing configurable -- and adding six branding columns to
-- the tenancy root would put a logo path on the row every access check reads.
-- =============================================================================

create table organization_branding (
  organization_id   uuid primary key references organizations (id) on delete cascade,

  -- The canonical business name. Section 10: this is looked up, never inferred
  -- from a spreadsheet cell and never invented by a model.
  business_name     text check (length(btrim(business_name)) between 1 and 120),
  legal_name        text check (length(btrim(legal_name)) between 1 and 200),

  -- Priority 1 of the logo resolution: an object in the private `branding`
  -- bucket. Stored as a path rather than a URL because a URL to a private
  -- object is a signed one, which expires -- persisting it would guarantee a
  -- report that renders a broken image some weeks after it was configured.
  logo_storage_path text,
  logo_mime_type    text check (logo_mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  logo_width        integer check (logo_width between 1 and 4000),
  logo_height       integer check (logo_height between 1 and 4000),
  logo_byte_size    integer check (logo_byte_size between 1 and 2097152),

  -- Priority 4: a public URL an administrator supplied. Checked for shape here
  -- and for SSRF safety in the application before anything fetches it -- the
  -- database can enforce "https and not a private literal", not "this hostname
  -- does not resolve into our VPC".
  logo_url          text check (
    logo_url is null or (
      logo_url ~* '^https://[a-z0-9.-]+(:[0-9]+)?(/|$)'
      and length(logo_url) <= 2048
      and logo_url !~* '^https://(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)'
    )
  ),

  accent_color      text check (accent_color is null or accent_color ~* '^#[0-9a-f]{6}$'),
  footer_text       text check (length(footer_text) <= 200),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users (id) on delete set null
);

-- -----------------------------------------------------------------------------
-- Images found inside an uploaded workbook (section 11, priority 3).
--
-- A candidate is not branding. It is a row saying "this file contained this
-- picture, and here is how much it looks like a logo", and it becomes branding
-- only when a person says so. The bytes live in the `branding` bucket under the
-- organization, so approving one is a metadata write rather than a copy.
--
-- Scoped to the organization because that is who ends up owning the logo, with
-- the workspace and upload kept for the sentence on screen: "found in
-- January.xlsx, uploaded to Acme Ltd on 2 September".
-- -----------------------------------------------------------------------------

create table brand_asset_candidates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  workspace_id    uuid references workspaces (id) on delete set null,
  raw_upload_id   uuid references raw_uploads (id) on delete set null,

  storage_path    text not null,
  source_name     text not null,
  mime_type       text not null,
  width           integer check (width >= 0),
  height          integer check (height >= 0),
  byte_size       integer check (byte_size >= 0),
  sha256          text check (sha256 ~ '^[0-9a-f]{64}$'),

  -- How much this looks like a logo, and the sentences behind the number. Both
  -- are shown: a score with no reasons is a machine asking to be trusted.
  score           numeric(4, 3) not null default 0 check (score between 0 and 1),
  reasons         jsonb not null default '[]'::jsonb,
  usable          boolean not null default true,
  rejected_reason text,

  approved_at     timestamptz,
  approved_by     uuid references auth.users (id) on delete set null,
  dismissed_at    timestamptz,

  created_at      timestamptz not null default now(),

  unique (organization_id, sha256)
);

create index brand_asset_candidates_org_idx
  on brand_asset_candidates (organization_id, score desc, created_at desc);
create index brand_asset_candidates_open_idx
  on brand_asset_candidates (organization_id)
  where approved_at is null and dismissed_at is null;

create or replace function touch_organization_branding()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

create trigger organization_branding_touch
  before update on organization_branding
  for each row execute function touch_organization_branding();

-- =============================================================================
-- Storage.
--
-- A fourth private bucket rather than a prefix inside `exports`, for the same
-- reason `raw` is its own bucket: retention differs. An export is regenerable
-- and a logo is not, and a retention rule that sweeps last quarter's reports
-- must not take the client's identity with it.
--
--   organizations/{organization_id}/branding/logo
--   organizations/{organization_id}/branding/candidates/{sha256}
--
-- The read policy reads the tenant out of the *second* segment here, not the
-- first, because the first is the literal "organizations". That difference is
-- deliberate: the layout is human-readable in a storage browser, and an
-- accidental match against the other buckets' `{org}/{workspace}/` shape would
-- be worse than a policy that has to know which bucket it is looking at.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branding', 'branding', false, 2097152,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

create policy storage_read_own_org_branding
  on storage.objects for select to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = 'organizations'
    and is_org_member(try_uuid((storage.foldername(name))[2]))
  );

-- No insert, update or delete policy for `authenticated`, matching every other
-- bucket: bytes arrive through a server-side route that has already checked the
-- caller is an owner or admin, using the service role. The absence is the
-- design, not an omission.

-- =============================================================================
-- Write path. Same rule as everywhere else: the entity write and its audit row
-- share a transaction by construction.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Branding fields a person edits on the settings screen.
--
-- Owners and admins only. Branding is what a client sees on every document the
-- firm sends; it is not a member-level setting, for the same reason creating a
-- billable workspace is not.
--
-- Null means "leave alone" and the empty string means "clear it". Without that
-- distinction a screen that saves one field has to send all of them back, and
-- the first time it forgets one it silently erases it.
-- -----------------------------------------------------------------------------

create or replace function upsert_organization_branding(
  p_organization_id uuid,
  p_business_name   text default null,
  p_legal_name      text default null,
  p_accent_color    text default null,
  p_footer_text     text default null,
  p_logo_url        text default null
)
returns organization_branding
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role  org_role := org_role_of(p_organization_id);
  v_row   organization_branding;
begin
  if v_role is null then
    raise exception 'not a member of organization %', p_organization_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'role % may not change branding', v_role
      using errcode = 'insufficient_privilege';
  end if;

  insert into organization_branding (organization_id, updated_by)
  values (p_organization_id, auth.uid())
  on conflict (organization_id) do nothing;

  update organization_branding
     set business_name = case
           when p_business_name is null then business_name
           else nullif(btrim(p_business_name), '')
         end,
         legal_name = case
           when p_legal_name is null then legal_name
           else nullif(btrim(p_legal_name), '')
         end,
         accent_color = case
           when p_accent_color is null then accent_color
           else nullif(lower(btrim(p_accent_color)), '')
         end,
         footer_text = case
           when p_footer_text is null then footer_text
           else nullif(btrim(p_footer_text), '')
         end,
         logo_url = case
           when p_logo_url is null then logo_url
           else nullif(btrim(p_logo_url), '')
         end,
         updated_by = auth.uid()
   where organization_id = p_organization_id
  returning * into v_row;

  perform write_audit(
    p_organization_id, null, 'branding.updated', 'organization_branding',
    p_organization_id::text,
    jsonb_build_object(
      'business_name', v_row.business_name,
      'accent_color', v_row.accent_color,
      'has_logo', v_row.logo_storage_path is not null
    )
  );

  return v_row;
end;
$fn$;

revoke all on function upsert_organization_branding(uuid, text, text, text, text, text)
  from public, anon;
grant execute on function upsert_organization_branding(uuid, text, text, text, text, text)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Attaching a logo that has already been validated and stored.
--
-- service_role only. The bytes go through a route that sniffs the format,
-- measures the image and refuses anything outside the supported set, and that
-- route holds the service key -- so the check that matters happens before this
-- is called. Granting it to `authenticated` would let a client name a storage
-- path directly, which is the one thing the whole upload path exists to prevent.
-- -----------------------------------------------------------------------------

create or replace function set_organization_logo(
  p_organization_id uuid,
  p_storage_path    text,
  p_mime_type       text,
  p_width           integer,
  p_height          integer,
  p_byte_size       integer,
  p_actor           uuid default null
)
returns organization_branding
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row organization_branding;
begin
  if p_storage_path is null or btrim(p_storage_path) = '' then
    raise exception 'a logo needs a storage path';
  end if;

  -- The path must live under this organization's own prefix. Belt and braces:
  -- the caller builds the path, and a caller that built it wrong would
  -- otherwise point one tenant's branding row at another tenant's object.
  if p_storage_path not like 'organizations/' || p_organization_id::text || '/branding/%' then
    raise exception 'logo path % is not inside organization %',
      p_storage_path, p_organization_id using errcode = 'check_violation';
  end if;

  insert into organization_branding (
    organization_id, logo_storage_path, logo_mime_type,
    logo_width, logo_height, logo_byte_size, logo_url, updated_by
  )
  values (
    p_organization_id, p_storage_path, p_mime_type,
    p_width, p_height, p_byte_size, null, p_actor
  )
  on conflict (organization_id) do update
     set logo_storage_path = excluded.logo_storage_path,
         logo_mime_type    = excluded.logo_mime_type,
         logo_width        = excluded.logo_width,
         logo_height       = excluded.logo_height,
         logo_byte_size    = excluded.logo_byte_size,
         -- An uploaded logo wins over a remote URL, so the URL is cleared
         -- rather than left to be a stale second answer to the same question.
         logo_url          = null,
         updated_by        = coalesce(p_actor, organization_branding.updated_by)
  returning * into v_row;

  insert into audit_logs (org_id, actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_organization_id, p_actor, 'branding.logo_set', 'organization_branding',
    p_organization_id::text,
    jsonb_build_object('path', p_storage_path, 'mime', p_mime_type,
                       'width', p_width, 'height', p_height)
  );

  return v_row;
end;
$fn$;

revoke all on function set_organization_logo(uuid, text, text, integer, integer, integer, uuid)
  from public, anon, authenticated;
grant execute on function set_organization_logo(uuid, text, text, integer, integer, integer, uuid)
  to service_role;

create or replace function clear_organization_logo(p_organization_id uuid)
returns organization_branding
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role org_role := org_role_of(p_organization_id);
  v_row  organization_branding;
begin
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'not permitted to change branding for organization %', p_organization_id
      using errcode = 'insufficient_privilege';
  end if;

  update organization_branding
     set logo_storage_path = null,
         logo_mime_type = null,
         logo_width = null,
         logo_height = null,
         logo_byte_size = null,
         updated_by = auth.uid()
   where organization_id = p_organization_id
  returning * into v_row;

  perform write_audit(
    p_organization_id, null, 'branding.logo_cleared', 'organization_branding',
    p_organization_id::text, '{}'::jsonb
  );

  return v_row;
end;
$fn$;

revoke all on function clear_organization_logo(uuid) from public, anon;
grant execute on function clear_organization_logo(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Candidates discovered during ingest.
--
-- Written by the worker, which has already extracted and stored the bytes. The
-- unique constraint on (organization_id, sha256) makes re-uploading the same
-- workbook idempotent: the same picture in twelve monthly files is one row that
-- somebody has already dismissed, not twelve identical prompts.
-- -----------------------------------------------------------------------------

create or replace function record_brand_asset_candidates(
  p_organization_id uuid,
  p_workspace_id    uuid,
  p_raw_upload_id   uuid,
  p_candidates      jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_count integer := 0;
begin
  if jsonb_typeof(coalesce(p_candidates, 'null'::jsonb)) <> 'array' then
    return 0;
  end if;

  insert into brand_asset_candidates (
    organization_id, workspace_id, raw_upload_id, storage_path, source_name,
    mime_type, width, height, byte_size, sha256, score, reasons, usable, rejected_reason
  )
  select
    p_organization_id,
    p_workspace_id,
    p_raw_upload_id,
    item ->> 'storage_path',
    left(coalesce(item ->> 'source_name', 'image'), 200),
    item ->> 'mime_type',
    nullif(item ->> 'width', '')::integer,
    nullif(item ->> 'height', '')::integer,
    nullif(item ->> 'byte_size', '')::integer,
    item ->> 'sha256',
    least(greatest(coalesce((item ->> 'score')::numeric, 0), 0), 1),
    coalesce(item -> 'reasons', '[]'::jsonb),
    coalesce((item ->> 'usable')::boolean, true),
    left(item ->> 'rejected_reason', 300)
  from jsonb_array_elements(p_candidates) as item
  where item ->> 'storage_path' is not null
    and item ->> 'sha256' ~ '^[0-9a-f]{64}$'
  on conflict (organization_id, sha256) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

revoke all on function record_brand_asset_candidates(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function record_brand_asset_candidates(uuid, uuid, uuid, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- A person choosing one of them. This is the step that turns "an image we
-- found" into "the company logo", and nothing else in the system does it.
-- -----------------------------------------------------------------------------

create or replace function approve_brand_asset(p_candidate_id uuid)
returns organization_branding
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_candidate brand_asset_candidates;
  v_role      org_role;
  v_row       organization_branding;
begin
  select * into v_candidate from brand_asset_candidates where id = p_candidate_id;
  if v_candidate.id is null then
    raise exception 'no such image' using errcode = 'no_data_found';
  end if;

  v_role := org_role_of(v_candidate.organization_id);
  if v_role is null or v_role not in ('owner', 'admin') then
    -- Deliberately the same message a non-member gets: whether a candidate id
    -- exists in another tenant is not a fact this function discloses.
    raise exception 'no such image' using errcode = 'insufficient_privilege';
  end if;

  if not v_candidate.usable then
    raise exception 'that image cannot be used as a logo: %',
      coalesce(v_candidate.rejected_reason, 'unsupported image');
  end if;

  insert into organization_branding (
    organization_id, logo_storage_path, logo_mime_type,
    logo_width, logo_height, logo_byte_size, logo_url, updated_by
  )
  values (
    v_candidate.organization_id, v_candidate.storage_path, v_candidate.mime_type,
    v_candidate.width, v_candidate.height, v_candidate.byte_size, null, auth.uid()
  )
  on conflict (organization_id) do update
     set logo_storage_path = excluded.logo_storage_path,
         logo_mime_type    = excluded.logo_mime_type,
         logo_width        = excluded.logo_width,
         logo_height       = excluded.logo_height,
         logo_byte_size    = excluded.logo_byte_size,
         logo_url          = null,
         updated_by        = auth.uid()
  returning * into v_row;

  update brand_asset_candidates
     set approved_at = now(), approved_by = auth.uid()
   where id = p_candidate_id;

  perform write_audit(
    v_candidate.organization_id, v_candidate.workspace_id, 'branding.logo_approved',
    'brand_asset_candidate', p_candidate_id::text,
    jsonb_build_object('source_name', v_candidate.source_name, 'score', v_candidate.score)
  );

  return v_row;
end;
$fn$;

revoke all on function approve_brand_asset(uuid) from public, anon;
grant execute on function approve_brand_asset(uuid) to authenticated, service_role;

create or replace function dismiss_brand_asset(p_candidate_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_candidate brand_asset_candidates;
  v_role      org_role;
begin
  select * into v_candidate from brand_asset_candidates where id = p_candidate_id;
  if v_candidate.id is null then
    return false;
  end if;

  v_role := org_role_of(v_candidate.organization_id);
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'no such image' using errcode = 'insufficient_privilege';
  end if;

  update brand_asset_candidates set dismissed_at = now() where id = p_candidate_id;
  return true;
end;
$fn$;

revoke all on function dismiss_brand_asset(uuid) from public, anon;
grant execute on function dismiss_brand_asset(uuid) to authenticated, service_role;

-- =============================================================================
-- RLS. Members read their own organization's branding and nobody else's;
-- nobody writes directly.
-- =============================================================================

alter table organization_branding   enable row level security;
alter table brand_asset_candidates  enable row level security;

create policy organization_branding_select_members
  on organization_branding for select to authenticated
  using (is_org_member(organization_id));

create policy brand_asset_candidates_select_members
  on brand_asset_candidates for select to authenticated
  using (is_org_member(organization_id));

grant select on organization_branding, brand_asset_candidates to authenticated;
grant all on organization_branding, brand_asset_candidates to service_role;
