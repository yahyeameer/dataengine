-- =============================================================================
-- A workspace knows what currency it keeps its books in.
--
-- `proposed_changes.materiality_gbp` and `deviations.materiality_gbp` are what
-- rank a review queue: the point of the ranking is that one £40,000 unmatched
-- transaction outranks four hundred rounding errors. The figure is computed by
-- the agent from the customer's own numbers and has never had a currency of its
-- own -- the column name asserts one, and the dashboard formatted every figure
-- as GBP to match.
--
-- That was true enough while every customer was a UK accounting practice. It
-- stopped being true when this product grew a second half: a shop in Bakaara
-- whose store report is denominated in dollars and shillings still sees its
-- cleaning proposals ranked in pounds, because the two halves had no shared
-- place to say what the money is.
--
-- This is that place. It is on the workspace rather than the organisation
-- because a practice can perfectly well keep one client's books in GBP and
-- another's in USD, and the workspace is already the unit everything else in
-- this system is scoped to.
--
-- The column is *not* a conversion rate and nothing here converts. It records
-- what the figures already are, so the dashboard can label them correctly
-- instead of guessing. Renaming `materiality_gbp` is the obvious follow-on and
-- is deliberately not done here: it is written by the worker, read by two
-- components and three scripts, and is a rename worth doing on its own.
-- =============================================================================

alter table workspaces
  add column if not exists currency text not null default 'GBP'
  check (currency ~ '^[A-Z]{3,5}$');

comment on column workspaces.currency is
  'The currency the figures in this workspace already are. Not a conversion '
  'rate; nothing converts. Used to label materiality and report figures.';


-- -----------------------------------------------------------------------------
-- `create_workspace`, with somewhere to say it.
--
-- The three-argument form is dropped rather than left beside a four-argument
-- one. An overload would be ambiguous to any caller that binds by name --
-- PostgREST does, and so does the pipeline end-to-end harness -- and "two
-- functions with the same name, one of which is stale" is the shape of a bug
-- that appears months later in whichever caller was not updated.
-- -----------------------------------------------------------------------------

drop function if exists create_workspace(uuid, text, text);

create or replace function create_workspace(
  p_org_id      uuid,
  p_name        text,
  p_client_name text default null,
  p_currency    text default 'GBP'
)
returns workspaces
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role org_role := org_role_of(p_org_id);
  v_ws   workspaces;
begin
  if v_role is null then
    raise exception 'not a member of organization %', p_org_id using errcode = 'insufficient_privilege';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'role % may not create workspaces', v_role using errcode = 'insufficient_privilege';
  end if;

  insert into workspaces (org_id, name, client_name, currency, created_by)
  values (
    p_org_id,
    btrim(p_name),
    nullif(btrim(coalesce(p_client_name, '')), ''),
    upper(coalesce(nullif(btrim(p_currency), ''), 'GBP')),
    auth.uid()
  )
  returning * into v_ws;

  perform write_audit(
    p_org_id, v_ws.id, 'workspace.created', 'workspace', v_ws.id::text,
    jsonb_build_object('name', v_ws.name, 'client_name', v_ws.client_name,
                       'currency', v_ws.currency)
  );

  return v_ws;
end;
$fn$;

revoke all on function create_workspace(uuid, text, text, text) from public, anon;
grant execute on function create_workspace(uuid, text, text, text) to authenticated;
