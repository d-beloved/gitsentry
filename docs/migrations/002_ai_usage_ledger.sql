-- Migration 002: AI usage ledger
-- Run in Supabase SQL editor (Dashboard → SQL Editor → New query → Run).
-- Idempotent — safe to run on an existing database.
--
-- One row per AI provider call, written by both the backend (PR scans, sweeps,
-- classifier, security-context discovery) and the web admin app (outreach
-- sweeps, outreach enrichment, social post generation). This is the single
-- source of truth for "what are we spending on AI" — the finance dashboard
-- prices rows by their exact `model` string and groups them by `surface`,
-- instead of guessing a call's purpose from which model name it happens to
-- share with another surface.
--
-- surface values in use:
--   'pr_scan'            — apps/backend: per-PR diff scan (GEMINI_SCAN_MODEL)
--   'security_sweep'     — apps/backend: manual/scheduled deep sweep (GEMINI_SWEEP_MODEL)
--   'discovery'          — apps/backend: one-time repo auth-file analysis (GEMINI_DISCOVERY_MODEL)
--   'classifier'         — apps/backend: per-scan project-type classification (GEMINI_DISCOVERY_MODEL)
--   'outreach_sweep'     — apps/web: cold-outreach target vulnerability sweep (GEMINI_OUTREACH_MODEL)
--   'outreach_classifier'— apps/web: project-type classification for the above (GEMINI_OUTREACH_MODEL)
--   'outreach_summary'   — apps/web: company/repo summary enrichment (GEMINI_OUTREACH_MODEL)
--   'social_post'        — apps/web: social post generation (GEMINI_SOCIAL_MODEL)

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

-- Migration: add outreach_target_id to existing installs (dedupe key for the
-- one-time backfill in 003_backfill_ai_usage.sql — outreach rows have no
-- scan_id of their own to key off of).
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS outreach_target_id UUID REFERENCES outreach_targets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_usage_created_at_idx ON ai_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_surface_idx    ON ai_usage(surface);
