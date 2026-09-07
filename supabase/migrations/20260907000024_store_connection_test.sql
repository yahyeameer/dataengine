-- =============================================================================
-- Testing a store connection before anybody waits on a month end.
--
-- The gap this closes is not technical. A shop owner in Bakaara does not know
-- what a "refresh token" is; what they have is whatever their accountant or
-- their Odoo integrator sent them. Before this, they typed it into four boxes
-- and found out whether it was right at the first sync -- which is to say, at
-- the moment they were waiting for a report.
--
-- `test_store_connection` is a job that reads the stored credential, works out
-- what the owner actually pasted, dials the system once, and answers in a
-- sentence: connected to which company, or exactly which piece is still
-- missing. It reads and never writes a ledger.
--
-- `apply_store_connection_setup` is how the worker keeps what it learned. A
-- credentials file usually carries the Odoo address, database and username
-- alongside the API key, and having read them once, asking the owner to type
-- them again would be the whole problem restated. It writes **only** non-secret
-- settings -- the secret half never leaves the vault -- and it is the one
-- function here that lets the worker touch a connection's settings, which is
-- why it names the fields it will accept rather than merging a blob.
--
-- As in 008, 011, 013 and 021: `alter type ... add value` is safe inside a
-- transaction as long as nothing in the same transaction uses the new value,
-- and nothing here does.
-- =============================================================================

alter type agent_job_kind add value if not exists 'test_store_connection';


-- -----------------------------------------------------------------------------
-- Keeping what the test worked out. Worker only.
--
-- Deliberately a named allow-list rather than `config = config || p_patch`. The
-- patch is derived from something a customer pasted, and a blob merge would let
-- whatever else was in that file become connection settings -- including keys a
-- future connector will read for something else entirely. Four fields are all
-- this can ever write.
-- -----------------------------------------------------------------------------

create or replace function apply_store_connection_setup(
  p_connection_id uuid,
  p_base_url      text default null,
  p_database      text default null,
  p_username      text default null,
  p_realm_id      text default null
)
returns store_connections
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_connection store_connections;
  v_config     jsonb;
  -- Cast on every append: `text[] || 'base_url'` is ambiguous to Postgres,
  -- which reads the unknown-typed literal as a malformed array rather than
  -- as an element, and fails at run time rather than at create time.
  v_learned    text[] := '{}';
begin
  select * into v_connection from store_connections where id = p_connection_id;
  if v_connection.id is null then
    raise exception 'store connection % not found', p_connection_id;
  end if;

  v_config := coalesce(v_connection.config, '{}'::jsonb);

  -- Only ever fills a blank. A setting the owner typed themselves outranks one
  -- read out of a file they pasted, and silently overwriting the first with the
  -- second is how a connection starts pointing at an integrator's demo
  -- database three weeks after it was working.
  if p_base_url is not null and coalesce(v_config->>'base_url', '') = '' then
    v_config := jsonb_set(v_config, '{base_url}', to_jsonb(p_base_url));
    v_learned := v_learned || 'base_url'::text;
  end if;
  if p_database is not null and coalesce(v_config->>'database', '') = '' then
    v_config := jsonb_set(v_config, '{database}', to_jsonb(p_database));
    v_learned := v_learned || 'database'::text;
  end if;
  if p_username is not null and coalesce(v_config->>'username', '') = '' then
    v_config := jsonb_set(v_config, '{username}', to_jsonb(p_username));
    v_learned := v_learned || 'username'::text;
  end if;
  if p_realm_id is not null and coalesce(v_config->>'realm_id', '') = '' then
    v_config := jsonb_set(v_config, '{realm_id}', to_jsonb(p_realm_id));
    v_learned := v_learned || 'realm_id'::text;
  end if;

  if array_length(v_learned, 1) is null then
    return v_connection;
  end if;

  update store_connections
     set config = v_config, updated_at = now()
   where id = p_connection_id
  returning * into v_connection;

  -- The field names, never their values. An Odoo address is not a secret, but
  -- an audit log that grows a copy of every setting on every test is a log
  -- nobody reads.
  perform write_audit(
    v_connection.org_id, v_connection.workspace_id, 'store.connection.setup_learned',
    'store_connection', p_connection_id::text,
    jsonb_build_object('fields', to_jsonb(v_learned), 'learned_by', 'agent')
  );

  return v_connection;
end;
$fn$;

revoke all on function apply_store_connection_setup(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function apply_store_connection_setup(uuid, text, text, text, text)
  to service_role;
