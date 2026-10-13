-- Migration 008: exclude quota_exceeded ledger rows (nothing was analysed) from lifetime scan counts.
-- Matches VISIBLE_SCAN_FILTER in apps/web/lib/scan.ts. Idempotent.
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
