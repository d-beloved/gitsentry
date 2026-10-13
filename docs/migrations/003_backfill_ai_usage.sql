-- Migration 003: backfill ai_usage from scans/outreach_targets token columns. Run after 002.
-- Idempotent via NOT EXISTS guards; only pr_scan, security_sweep and outreach_sweep are recoverable.

-- 1. Backfill from scans (pr_scan / security_sweep)
INSERT INTO ai_usage (surface, model, tokens_in, tokens_out, scan_id, repo_id, created_at)
SELECT
  CASE WHEN s.trigger_type = 'security_sweep' THEN 'security_sweep' ELSE 'pr_scan' END AS surface,
  s.ai_model,
  s.tokens_in,
  s.tokens_out,
  s.id,
  s.repo_id,
  s.created_at
FROM scans s
WHERE s.ai_model IS NOT NULL
  AND (s.tokens_in > 0 OR s.tokens_out > 0)
  AND NOT EXISTS (
    SELECT 1 FROM ai_usage au
    WHERE au.scan_id = s.id
      AND au.surface = CASE WHEN s.trigger_type = 'security_sweep' THEN 'security_sweep' ELSE 'pr_scan' END
  );

-- 2. Backfill from outreach_targets (outreach_sweep only)
INSERT INTO ai_usage (surface, model, tokens_in, tokens_out, outreach_target_id, created_at)
SELECT
  'outreach_sweep',
  o.ai_model,
  o.tokens_in,
  o.tokens_out,
  o.id,
  o.created_at
FROM outreach_targets o
WHERE o.ai_model IS NOT NULL
  AND (o.tokens_in > 0 OR o.tokens_out > 0)
  AND NOT EXISTS (
    SELECT 1 FROM ai_usage au WHERE au.outreach_target_id = o.id AND au.surface = 'outreach_sweep'
  );
