-- Migration 008: keep quota-blocked ledger rows out of the admin lifetime count
-- Run in Supabase SQL editor. Idempotent — safe to run more than once.
--
-- A push that lands after an org has spent its monthly quota still writes a
-- `scans` row — status 'skipped', failure_reason 'quota_exceeded'. That row is a
-- ledger entry, not a scan: nothing was analysed. It exists so the "limit
-- reached" PR comment can be updated in place and so webhook redeliveries
-- dedupe. Every other count in the product filters it out through
-- VISIBLE_SCAN_FILTER (apps/web/lib/scan.ts); get_org_lifetime_scans did not, so
-- the admin Orgs table was the one surface counting rows nobody else counts.
--
-- The mismatch only showed up on free orgs. "Scans (month)" stops at the plan
-- cap (free 10, starter 50, pro 500) while lifetime kept climbing on every
-- blocked push, so a free account read as though its monthly counter had
-- stalled. Starter and pro looked correct only because they rarely reach a cap.
CREATE OR REPLACE FUNCTION get_org_lifetime_scans(p_org_ids UUID[])
RETURNS TABLE(org_id UUID, total BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT r.org_id, COUNT(s.id)::BIGINT AS total
    FROM repos r
    LEFT JOIN scans s
      ON s.repo_id = r.id
     AND (s.failure_reason IS NULL OR s.failure_reason <> 'quota_exceeded')
   WHERE r.org_id = ANY(p_org_ids)
   GROUP BY r.org_id;
$$;
