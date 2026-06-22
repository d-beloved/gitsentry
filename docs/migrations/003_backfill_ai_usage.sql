-- Migration 003: Backfill ai_usage from pre-existing token columns
-- Run in Supabase SQL editor, AFTER running 002_ai_usage_ledger.sql.
-- Idempotent — safe to run more than once (each INSERT is guarded by a
-- NOT EXISTS check keyed on scan_id/outreach_target_id, so re-running won't
-- double-count rows already backfilled).
--
-- Why this exists: the finance dashboard now reads exclusively from ai_usage.
-- Without this backfill, every month before ai_usage started getting written
-- to (i.e. before 002 was deployed) would show ~$0 AI spend even though real
-- spend happened — it's sitting in scans.tokens_in/tokens_out/ai_model and
-- outreach_targets.tokens_in/tokens_out/ai_model, just not in the new table.
-- Original created_at is preserved so the "Last 6 Months" breakdown still
-- buckets historical spend into the correct month.
--
-- Known gap this CANNOT fix: classifier, discovery, outreach_classifier,
-- outreach_summary, and social_post token usage was never captured anywhere
-- before this change (no column existed for it) — there is nothing to
-- backfill for those surfaces. Historical months will still under-report
-- total spend by whatever those calls actually cost; only pr_scan,
-- security_sweep, and outreach_sweep can be recovered.

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

-- 2. Backfill from outreach_targets (outreach_sweep only — classifier and
--    summary calls were never recorded on this table historically)
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
