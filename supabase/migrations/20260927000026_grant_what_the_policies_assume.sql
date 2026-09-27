-- =============================================================================
-- Grant the reads that two policies already claim to allow.
--
-- `20260901000021` enables RLS on `hmrc_sources` and `hmrc_change_reports` and
-- gives each a `for select to authenticated using (true)` policy, on the stated
-- reasoning that this is public GOV.UK guidance and identical for every
-- customer. Neither table was ever granted `select`.
--
-- A policy without a grant permits nothing. PostgreSQL checks the table
-- privilege first, so an authenticated session reading either table is refused
-- before any policy is consulted -- the two policies are inert, and the moment
-- somebody builds the screen for the HMRC knowledge monitor it would come back
-- empty with nothing to say why.
--
-- `20260819000002` warns about exactly this: "authenticated gets no explicit
-- grant. So grant deliberately, and grant only SELECT." This is that grant,
-- made deliberately.
--
-- The worker is unaffected either way: it writes through `record_hmrc_source`,
-- which is SECURITY DEFINER and runs as the owner.
-- =============================================================================

grant select on hmrc_sources, hmrc_change_reports to authenticated;

-- service_role writes them through the definer function rather than directly,
-- but the queue RPCs legitimately span tenants and the rest of the agent tables
-- are granted to it, so keep the shape consistent rather than special-casing
-- these two.
grant all on hmrc_sources, hmrc_change_reports to service_role;
