-- =============================================================================
-- Making the assistant's history something a person owns.
--
-- Numbered with the version the database recorded when this was applied, not
-- the next number in this directory's sequence -- same reason as the migration
-- before it. See the header of 20260831125512 for the skew this convention is
-- walking back.
--
-- `hermes_answers` has been append-only in practice since it shipped: members
-- could read their workspace's rows and nothing in the product could remove
-- one. That was fine while the table backed a single panel showing the last
-- thirty turns of one workspace. It stops being fine the moment the history is
-- a console the customer works in -- a question asked with a client's name
-- spelled wrong, the same question fired three times because the first felt
-- slow, an answer nobody wants kept. A record you cannot prune is not a record,
-- it is a drawer.
--
-- Two levels, because they answer different worries:
--
--   `deleted_at` set  -- out of the way, still recoverable. What people
--                        actually want nine times out of ten, and the only
--                        state that makes a bulk "clear these duplicates"
--                        button safe to press.
--
--   row deleted       -- gone from Postgres. What "delete it properly" means
--                        to someone who has typed a client's turnover into a
--                        question box, and the only answer that is true when
--                        they ask whether it is still on the server.
--
-- The hard delete leaves an `audit_logs` entry behind. That entry names who
-- deleted what and when, and carries no part of the question text -- the point
-- of the deletion was to remove that text, and an audit trail that quietly kept
-- a copy would be worse than no deletion at all.
-- =============================================================================

alter table hermes_answers
  add column deleted_at timestamptz;

-- The console reads the live history far more often than the trash, and both
-- reads are per-workspace and newest first. The existing
-- hermes_answers_workspace_idx still serves the trash view and any full sweep;
-- this one keeps the common read from touching removed rows at all.
create index hermes_answers_live_idx
  on hermes_answers (workspace_id, created_at desc)
  where deleted_at is null;

-- -----------------------------------------------------------------------------
-- Access is unchanged, deliberately.
--
-- `hermes_answers_select_members` still returns every row of a workspace the
-- caller belongs to, including the removed ones. That is what makes a trash
-- view possible: hiding removed rows in the policy would mean the only way to
-- offer "restore" was a service-role read, which is a much larger key than the
-- job needs.
--
-- Writes stay where they were. Members hold `select` and nothing else, so both
-- levels of deletion go through /api/hermes/history, which proves membership
-- with the caller's own client before it constructs the admin one.
-- -----------------------------------------------------------------------------

comment on column hermes_answers.deleted_at is
  'Set when a member removes the turn from their history. The row is still '
  'readable so it can be restored; the console filters it out. Permanent '
  'deletion removes the row entirely and writes an audit_logs entry.';
