-- =============================================================================
-- Where the agent's answers land.
--
-- The Hermes gateway is fire-and-forget: a webhook POST returns
-- {"status":"accepted"} in milliseconds and the agent's reply goes to the
-- route's delivery target, never back down the HTTP connection that asked. So
-- a question and its answer are two separate events, and something has to hold
-- the space between them.
--
-- This table is that space. The dashboard writes a row when it asks; the agent
-- writes the answer into the same row when it finishes, through the Supabase
-- MCP it already has; the browser watches the row over Realtime, exactly as the
-- agent panel already watches jobs. No callback URL, no second service, and
-- nothing blocking a Vercel function for the two minutes an agent turn can take.
--
-- Deliberately not agent_jobs. That queue is a contract with a worker that
-- claims, leases and reports -- a protocol this has no part in. Borrowing it
-- would mean a row no worker may claim sitting in the same table workers poll,
-- which is the kind of shortcut that reads as a bug six months later.
-- =============================================================================

create table hermes_answers (
  id           uuid primary key default gen_random_uuid(),

  -- The id travelling in the webhook payload, which the agent echoes back in
  -- its update. Text rather than uuid because it is matched by an agent
  -- interpolating a string into SQL, and a type error there would fail the
  -- write after the thinking has already been paid for.
  request_id   text not null unique check (length(btrim(request_id)) between 8 and 200),

  workspace_id uuid not null references workspaces (id) on delete cascade,
  asked_by     uuid references auth.users (id) on delete set null,

  question     text not null check (length(btrim(question)) between 1 and 4000),
  answer       text,

  -- pending -> done, or pending -> failed. No enum: this is a small local
  -- vocabulary, and an agent writing 'done' into a text column cannot fail the
  -- way it can against a type it must name exactly.
  status       text not null default 'pending'
               check (status in ('pending', 'done', 'failed')),
  error        text,

  created_at   timestamptz not null default now(),
  answered_at  timestamptz,

  constraint hermes_answers_answered_ck check (
    (status = 'pending' and answered_at is null)
    or (status <> 'pending' and answered_at is not null)
  )
);

create index hermes_answers_workspace_idx
  on hermes_answers (workspace_id, created_at desc);
create index hermes_answers_open_idx
  on hermes_answers (created_at) where status = 'pending';

-- -----------------------------------------------------------------------------
-- Access.
--
-- Read-only for members, and only their own workspace's rows -- the same rule
-- every other table here follows. Nobody writes through this policy: the
-- dashboard inserts with the service role after requireWorkspaceAccess has run,
-- and the agent updates through its own account-level MCP connection.
--
-- Worth being explicit about what that second half means. The agent is
-- RLS-exempt, so nothing in this file constrains which workspace it reads while
-- answering. The scope in its route prompt is an instruction, not a boundary.
-- This table records who asked and about which workspace, which at least makes
-- the question auditable after the fact.
-- -----------------------------------------------------------------------------

alter table hermes_answers enable row level security;

create policy hermes_answers_select_members
  on hermes_answers for select to authenticated
  using (has_workspace_access(workspace_id));

grant select on hermes_answers to authenticated;
grant all on hermes_answers to service_role;

-- Realtime, so the browser learns the answer arrived without polling. The
-- publication is how Supabase decides which tables stream.
alter publication supabase_realtime add table hermes_answers;
