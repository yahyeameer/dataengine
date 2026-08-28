-- =============================================================================
-- Pin search_path on the append-only guards added by 005 and 008.
--
-- 010 did this for the three trigger functions that existed at the time
-- (reject_mutation, raw_uploads_guard, try_uuid). The agent and recipe
-- migrations then introduced three more of the same shape without the setting,
-- so the linter flagged them the moment those migrations landed.
--
-- Same reasoning as 010: a function with a mutable search_path resolves
-- unqualified names against whatever the caller's search_path happens to be.
-- These three are pure logic -- they compare OLD and NEW fields and raise --
-- so an empty search_path costs them nothing. Every operator they use,
-- including enum comparison, resolves from pg_catalog, which is always
-- implicitly searched.
--
-- Worth doing rather than muting: these are the triggers that make
-- proposed_changes, recipe_runs and deviations append-only, which is what stops
-- an approval being re-pointed at a different operation after the fact. They
-- are exactly the functions that should be hardest to talk into running
-- someone else's code.
-- =============================================================================

alter function proposed_changes_guard() set search_path = '';
alter function recipe_runs_guard() set search_path = '';
alter function deviations_guard() set search_path = '';
