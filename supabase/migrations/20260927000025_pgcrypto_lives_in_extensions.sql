-- =============================================================================
-- Put pgcrypto where the code already assumes it is.
--
-- `20260831125512` fixed a bug where `kanban_run_start` called
-- `gen_random_bytes` unqualified, found nothing, and failed every bridged job
-- three times. The fix was to write `extensions.gen_random_bytes`, because on a
-- Supabase project pgcrypto is pre-installed in the `extensions` schema.
--
-- That fix is correct on Supabase and nowhere else. `20260819000001` says only
-- `create extension if not exists "pgcrypto"`, with no schema, so on a fresh
-- PostgreSQL the extension lands in `public` -- there is no `extensions` schema
-- at all -- and `kanban_run_start` fails with `schema "extensions" does not
-- exist`. Same symptom, same three wasted attempts, different environment: the
-- migration tree has never been able to build a working database on its own.
--
-- That matters because this repository documents self-hosting on a VPS and now
-- has an end-to-end suite (`npm run test:pipeline`) that builds a database from
-- these files with no Supabase image involved.
--
-- So: make the tree produce the layout the code expects, everywhere, and be
-- idempotent about it.
--
--   * on Supabase, pgcrypto is already in `extensions` and both statements
--     below are no-ops;
--   * on a database built from this directory, the extension is moved out of
--     `public` into `extensions`, which is also the right place for it on its
--     own merits -- PostgREST exposes `public`, and there is no reason for a
--     browser to be able to call `crypt()` or `gen_salt()`.
--
-- `gen_random_uuid()` is deliberately untouched. It is core PostgreSQL since 13
-- rather than pgcrypto, which is exactly why it kept working throughout and hid
-- the shape of the original bug.
-- =============================================================================

create schema if not exists extensions;

-- Everything that resolves a name against this schema needs to see it. Granted
-- to the same roles Supabase grants it to; it carries no data of its own.
grant usage on schema extensions to postgres, anon, authenticated, service_role;

do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto';

  if v_schema is null then
    -- Not installed at all, which is neither of the two cases above but is
    -- worth handling rather than leaving to fail later.
    execute 'create extension pgcrypto with schema extensions';
  elsif v_schema <> 'extensions' then
    execute 'alter extension pgcrypto set schema extensions';
  end if;
end $$;
