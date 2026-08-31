-- =============================================================================
-- One new job kind, alone in its own migration.
--
-- `alter type ... add value` cannot be used in the same transaction that adds
-- it (Postgres refuses: the new label is not visible until the transaction
-- commits). The Supabase CLI runs each migration file in one transaction, so
-- the value has to arrive in a file of its own and everything that references
-- it lands in the next one.
--
-- `kanban_report` is the customer-facing name for a job whose work is done by
-- the internal Kanban chain -- supervisor, analyst, reporter, verifier -- and
-- returned through the Python worker. The existing `generate_report` is
-- untouched and remains the deterministic single-worker path; this one is the
-- multi-agent one, and the two are separate kinds precisely so that enabling
-- the second cannot change the behaviour of the first.
-- =============================================================================

alter type agent_job_kind add value if not exists 'kanban_report';
