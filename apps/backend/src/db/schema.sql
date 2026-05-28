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
  status          TEXT DEFAULT 'pending', -- 'pending' | 'complete' | 'failed'
  duration_ms     INT,
  gh_comment_id   BIGINT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: add gh_comment_id to existing installs
ALTER TABLE scans ADD COLUMN IF NOT EXISTS gh_comment_id BIGINT;

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

-- Phase 4: store installation_id on repos so sweep can authenticate GitHub calls
ALTER TABLE repos ADD COLUMN IF NOT EXISTS installation_id BIGINT;
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
CREATE INDEX IF NOT EXISTS idx_installations_installer ON installations(installer_github_id);
