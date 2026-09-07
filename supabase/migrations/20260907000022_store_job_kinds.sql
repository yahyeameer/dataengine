-- =============================================================================
-- Two new job kinds, alone in their own migration.
--
-- Same constraint as 018: `alter type ... add value` cannot be used in the same
-- transaction that adds it, the Supabase CLI runs each migration file in one
-- transaction, so the values arrive in a file of their own and everything that
-- references them lands in the next one.
--
-- `sync_store` reads a connected shop's own system -- a spreadsheet it already
-- uploaded, a QuickBooks Online company, an Odoo instance -- and writes the
-- result as an ordinary immutable dataset version. It is a *reader*: it creates
-- versions and never modifies one.
--
-- `store_financials` takes such a version and produces the revenue, cost and
-- profit report for a day, week, month or year. It is separate from
-- `generate_report` and not a mode of it, because the two answer different
-- questions from differently shaped data: `generate_report` describes an
-- arbitrary cleaned dataset for an accountant, and this one answers "did my
-- shop make money this month" from a normalised ledger. Sharing one kind would
-- mean one handler branching on payload, and the branch nobody exercised would
-- be the one that broke.
-- =============================================================================

alter type agent_job_kind add value if not exists 'sync_store';
alter type agent_job_kind add value if not exists 'store_financials';
