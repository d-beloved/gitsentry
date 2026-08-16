-- Run this against your Supabase project to create the Gitsentry.dev schema.
-- This script is idempotent: safe to run multiple times on an existing database.
-- Fresh install: tables are created with all columns.
-- Existing install: tables are skipped, ALTER TABLE adds any missing columns.

-- ── Core tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orgs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id     BIGINT UNIQUE NOT NULL,
  login         TEXT NOT NULL,
  avatar_url    TEXT,
  plan          TEXT DEFAULT 'free',  -- 'free' | 'pro' | 'team'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS repos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID REFERENCES orgs(id) ON DELETE CASCADE,
  github_id       BIGINT UNIQUE NOT NULL,
  full_name       TEXT NOT NULL,
  default_branch  TEXT DEFAULT 'main',
  is_active       BOOLEAN DEFAULT TRUE,
  watch_prs       BOOLEAN DEFAULT TRUE,
  watch_pushes    BOOLEAN DEFAULT TRUE,
  watch_main      BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID REFERENCES repos(id) ON DELETE CASCADE,
  trigger_type    TEXT NOT NULL,        -- 'pull_request' | 'push_main' | 'push_branch'
  trigger_ref     TEXT NOT NULL,
  commit_sha      TEXT NOT NULL,
  author          TEXT,
  files_changed   INT DEFAULT 0,
  lines_added     INT DEFAULT 0,
  findings_count  INT DEFAULT 0,
  critical_count  INT DEFAULT 0,
  high_count      INT DEFAULT 0,
  medium_count    INT DEFAULT 0,
  low_count       INT DEFAULT 0,
  status          TEXT DEFAULT 'pending', -- 'pending' | 'complete' | 'failed' | 'skipped'
  duration_ms     INT,
  gh_comment_id   BIGINT,
  failure_reason  TEXT,                    -- why a scan didn't complete (see migration 005)
  credit_refunded BOOLEAN DEFAULT FALSE,   -- true when a claimed quota slot was refunded
  error_detail    TEXT,                    -- raw exception message for admin diagnosis (migration 006)
  started_at      TIMESTAMPTZ,             -- when the worker picked the job up (migration 007)
  reaped_at       TIMESTAMPTZ,             -- set by the reaper; tombstone, blocks later writes (migration 007)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: add gh_comment_id to existing installs
ALTER TABLE scans ADD COLUMN IF NOT EXISTS gh_comment_id BIGINT;

-- Migration: quota-claim idempotency marker. Set once the scan has consumed a
-- monthly quota slot so Bull job retries never claim (and bill) twice.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS quota_claimed BOOLEAN DEFAULT FALSE;

-- Migration 005: truthful scan outcomes. status='skipped' means the scan was
-- intentionally not run (quota_exceeded | subscription_inactive | no_org |
-- no_diff); status='failed' means the pipeline errored (pipeline_error |
-- ai_error), and credit_refunded=true when the claimed quota slot was released.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS failure_reason  TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS credit_refunded BOOLEAN DEFAULT FALSE;

-- Migration 006: raw error message behind failure_reason, for admin diagnosis
-- without needing to check server logs. Admin-only surface, capped ~2000 chars.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS error_detail TEXT;

-- Migration 007: reaper accuracy. started_at is stamped at worker pickup (and
-- re-stamped on each Bull retry) so the reaper can judge a never-consumed job by
-- queue age and a died-mid-run job by run age, instead of treating a healthy
-- backlog as stranded. reaped_at is a tombstone: once set, updateScanStatus
-- refuses to write, so a late worker can't resurrect a refunded scan.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS reaped_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_scans_pending_reaper
  ON scans (created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS findings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id               UUID REFERENCES scans(id) ON DELETE CASCADE,
  repo_id               UUID REFERENCES repos(id) ON DELETE CASCADE,
  severity              TEXT NOT NULL,
  category              TEXT NOT NULL,
  file_path             TEXT NOT NULL,
  line_number           INT,
  code_snippet          TEXT,
  description           TEXT NOT NULL,
  fix_suggestion        TEXT NOT NULL,
  affected_component    TEXT,
  exploitation_scenario TEXT,
  impact                TEXT,
  evidence              TEXT,
  confidence            TEXT,
  attacker_profile      TEXT,
  is_false_positive     BOOLEAN DEFAULT FALSE,
  is_resolved           BOOLEAN DEFAULT FALSE,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id       BIGINT UNIQUE NOT NULL,
  login           TEXT NOT NULL,
  email           TEXT,
  avatar_url      TEXT,
  org_id          UUID REFERENCES orgs(id),
  role            TEXT DEFAULT 'member',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID UNIQUE REFERENCES repos(id) ON DELETE CASCADE,
  slack_webhook   TEXT,
  email           TEXT,
  min_severity    TEXT DEFAULT 'high',
  alert_on_main   BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_scans     BIGINT DEFAULT 0,
  total_findings  BIGINT DEFAULT 0,
  total_repos     BIGINT DEFAULT 0,
  critical_caught BIGINT DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- GitHub App installations — links the installer to the org they installed on.
-- Used to let CTOs see their org's repos in the dashboard even when using a
-- personal GitHub account.
CREATE TABLE IF NOT EXISTS installations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_install_id   BIGINT UNIQUE NOT NULL,
  org_id              UUID REFERENCES orgs(id) ON DELETE CASCADE,
  installer_github_id BIGINT NOT NULL,   -- github_id of who clicked Install
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Migrations for existing deployments ───────────────────────────────────────
-- These are no-ops on a fresh install (columns already exist).
-- On an existing DB they add columns that were introduced after the first deploy.

ALTER TABLE findings ADD COLUMN IF NOT EXISTS affected_component    TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS exploitation_scenario TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS impact                TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS evidence              TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS confidence            TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS attacker_profile      TEXT;

-- Phase 5: stale findings — auto-labelled when a newer scan of the same trigger
-- re-read the file the finding lives in and no longer reproduced it (e.g. PR
-- updated after a fix). A scan that never looked at the file leaves the finding
-- alone: a `synchronize` scan only sees the incremental diff, so treating its
-- silence as a fix retired real findings nobody had addressed. See
-- markStaleFindings() in apps/backend/src/db/queries.ts.
ALTER TABLE findings ADD COLUMN IF NOT EXISTS is_stale BOOLEAN DEFAULT FALSE;

-- Phase 6: per-repo security context — auto-discovered on first scan and
-- updated as developers dismiss false positives. Injected into the AI prompt
-- so the scanner understands this repo's auth and rate-limit patterns.
ALTER TABLE repos ADD COLUMN IF NOT EXISTS security_context TEXT;

-- Tracks when security_context was last (re)discovered, so the scanner can
-- invalidate a stale cache after a TTL even when no auth file changed —
-- see resolveSecurityContext() in apps/backend/src/lib/securityContext.ts.
ALTER TABLE repos ADD COLUMN IF NOT EXISTS security_context_updated_at TIMESTAMPTZ;

-- Phase 6: monthly sweep quota tracking on orgs — mirrors scan_count_month /
-- scan_month but for security sweeps. Used to enforce per-plan monthly limits:
-- Starter = 1/month, Pro = 10/month. Free plan keeps using sweep_trials_used
-- (one-time lifetime trial).
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS sweep_count_month INT  DEFAULT 0;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS sweep_month       TEXT DEFAULT '';

-- Atomically claims a monthly sweep slot for an org.
-- Returns TRUE if a slot was granted, FALSE if the monthly limit is already reached.
CREATE OR REPLACE FUNCTION try_claim_sweep(
  p_org_id  UUID,
  p_month   TEXT,
  p_limit   INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INT;
  v_month TEXT;
BEGIN
  SELECT sweep_count_month, sweep_month
    INTO v_count, v_month
    FROM orgs
   WHERE id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- New billing month: reset counter and grant the slot
  IF v_month IS DISTINCT FROM p_month THEN
    UPDATE orgs
       SET sweep_count_month = 1,
           sweep_month       = p_month
     WHERE id = p_org_id;
    RETURN TRUE;
  END IF;

  IF v_count >= p_limit THEN
    RETURN FALSE;
  END IF;

  UPDATE orgs
     SET sweep_count_month = v_count + 1
   WHERE id = p_org_id;

  RETURN TRUE;
END;
$$;

-- Phase 4: store installation_id on repos so sweep can authenticate GitHub calls
ALTER TABLE repos ADD COLUMN IF NOT EXISTS installation_id BIGINT;

-- Phase 7: distinguish "removed from installation" from "never scanned yet"
-- Dashboard queries filter removed_at IS NULL to hide deselected repos.
ALTER TABLE repos ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS default_branch   TEXT DEFAULT 'main';

-- Phase 4: Paddle billing + usage tracking on orgs
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS paddle_customer_id       TEXT;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS paddle_subscription_id   TEXT;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS subscription_status      TEXT DEFAULT 'inactive';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS scan_count_month         INT  DEFAULT 0;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS scan_month               TEXT DEFAULT '';  -- 'YYYY-MM'
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS sweep_trials_used        INT  DEFAULT 0;

-- ── Seed ─────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public_stats) THEN
    INSERT INTO public_stats (total_scans, total_findings, total_repos, critical_caught)
    VALUES (0, 0, 0, 0);
  END IF;
END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_scans_repo_id         ON scans(repo_id);
CREATE INDEX IF NOT EXISTS idx_scans_created_at      ON scans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_scan_id      ON findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_repo_id      ON findings(repo_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity     ON findings(severity);
CREATE INDEX IF NOT EXISTS idx_findings_is_resolved  ON findings(is_resolved);
CREATE INDEX IF NOT EXISTS idx_findings_is_stale     ON findings(is_stale);
CREATE INDEX IF NOT EXISTS idx_installations_installer ON installations(installer_github_id);

-- ── RPC functions ─────────────────────────────────────────────────────────────

-- Atomically claims a monthly scan slot for an org.
-- Returns TRUE if a slot was granted, FALSE if the monthly limit is already reached.
-- Uses SELECT...FOR UPDATE to eliminate the TOCTOU race between reading the
-- counter and incrementing it. Called by tryClaimScan() in queries.ts.
CREATE OR REPLACE FUNCTION try_claim_scan(
  p_org_id  UUID,
  p_month   TEXT,
  p_limit   INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INT;
  v_month TEXT;
BEGIN
  -- Lock the row exclusively to prevent concurrent claims for the same org
  SELECT scan_count_month, scan_month
    INTO v_count, v_month
    FROM orgs
   WHERE id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- New billing month: reset counter and grant the slot
  IF v_month IS DISTINCT FROM p_month THEN
    UPDATE orgs
       SET scan_count_month = 1,
           scan_month       = p_month
     WHERE id = p_org_id;
    RETURN TRUE;
  END IF;

  -- Same month and limit already reached: deny
  IF v_count >= p_limit THEN
    RETURN FALSE;
  END IF;

  -- Claim one slot
  UPDATE orgs
     SET scan_count_month = v_count + 1
   WHERE id = p_org_id;

  RETURN TRUE;
END;
$$;

-- Atomically refunds one monthly sweep slot (e.g. when a sweep errors before
-- producing results). Uses FOR UPDATE to prevent the same lost-update race as
-- try_claim_sweep guards against on the claim side.
CREATE OR REPLACE FUNCTION refund_sweep(p_org_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INT;
BEGIN
  SELECT sweep_count_month
    INTO v_count
    FROM orgs
   WHERE id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_count > 0 THEN
    UPDATE orgs
       SET sweep_count_month = v_count - 1
     WHERE id = p_org_id;
  END IF;
END;
$$;

-- Atomically refunds one monthly scan slot (e.g. when a scan errors after
-- claiming its quota slot but before producing results). Mirrors refund_sweep,
-- but only refunds while the org is still inside the billing month the slot was
-- claimed in (p_month) so a month rollover never underflows the counter.
CREATE OR REPLACE FUNCTION refund_scan(p_org_id UUID, p_month TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INT;
  v_month TEXT;
BEGIN
  SELECT scan_count_month, scan_month
    INTO v_count, v_month
    FROM orgs
   WHERE id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_month IS DISTINCT FROM p_month THEN
    RETURN;
  END IF;

  IF v_count > 0 THEN
    UPDATE orgs
       SET scan_count_month = v_count - 1
     WHERE id = p_org_id;
  END IF;
END;
$$;

-- Returns lifetime scan totals per org, used by the admin dashboard.
-- Accepts an array of org UUIDs and returns one row per org that has repos.
CREATE OR REPLACE FUNCTION get_org_lifetime_scans(p_org_ids UUID[])
RETURNS TABLE(org_id UUID, total BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT r.org_id, COUNT(s.id)::BIGINT AS total
    FROM repos r
    LEFT JOIN scans s ON s.repo_id = r.id
   WHERE r.org_id = ANY(p_org_ids)
   GROUP BY r.org_id;
$$;
