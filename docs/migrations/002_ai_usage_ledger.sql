-- Migration 002: AI usage ledger, one row per provider call; source of truth for AI spend. Idempotent.
-- surface: pr_scan | security_sweep | discovery | classifier | outreach_sweep | outreach_classifier | outreach_summary | social_post

CREATE TABLE IF NOT EXISTS ai_usage (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  surface             TEXT NOT NULL,
  model               TEXT NOT NULL,
  tokens_in           INT  NOT NULL DEFAULT 0,
  tokens_out          INT  NOT NULL DEFAULT 0,
  scan_id             UUID REFERENCES scans(id) ON DELETE SET NULL,
  repo_id             UUID REFERENCES repos(id) ON DELETE SET NULL,
  outreach_target_id  UUID REFERENCES outreach_targets(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- outreach_target_id is the backfill dedupe key for outreach rows (no scan_id).
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS outreach_target_id UUID REFERENCES outreach_targets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_usage_created_at_idx ON ai_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_surface_idx    ON ai_usage(surface);
