-- A minimal Supabase-shaped environment: roles, auth, vault, storage, realtime.
-- Enough for every migration to apply and for the RPCs to run exactly as they
-- would in production. Nothing here is under test; it stands in for the
-- managed pieces this sandbox has no Docker to run.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  -- Supabase's service_role bypasses RLS. Saying so here is what makes the
  -- harness's worker-side reads behave as they do in production.
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
-- Applied unconditionally: roles are cluster-wide and survive `drop database`,
-- so a "create if not exists" silently skips the attribute on every run after
-- the first. Supabase's service_role bypasses RLS; saying so here is what makes
-- the harness's worker-side writes behave as they do in production.
alter role service_role bypassrls;
alter role authenticated nobypassrls;
alter role anon nobypassrls;

-- A Supabase project ships with pgcrypto already installed in `extensions`, and
-- code in this repository resolves `extensions.gen_random_bytes` against it. The
-- stub mimics that rather than installing pgcrypto into `public`, so the harness
-- builds the database production has instead of a more forgiving one.
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon'); $$;

create schema if not exists vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(),
  name text, description text, secret text);
create view vault.decrypted_secrets as
  select id, name, description, secret as decrypted_secret from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null,
  new_description text default '') returns uuid language sql as $$
  insert into vault.secrets (secret,name,description)
  values (new_secret,new_name,new_description) returning id; $$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null,
  new_name text default null, new_description text default null) returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id; $$;

create schema if not exists storage;
create table storage.buckets (id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], owner uuid,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text, owner uuid,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  last_accessed_at timestamptz, metadata jsonb);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$ select string_to_array(name, '/'); $$;
create or replace function storage.filename(name text) returns text
  language sql immutable as $$ select (string_to_array(name,'/'))[array_length(string_to_array(name,'/'),1)]; $$;

-- Realtime's publication, because a migration adds a table to it. The cluster
-- is started with wal_level=logical so this is silent; nothing here subscribes.
create publication supabase_realtime;
