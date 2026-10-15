-- Gitsentry.dev schema for Supabase. Idempotent: on an existing install,
-- CREATE TABLE is skipped and the ALTER TABLEs add any missing columns.

-- Core tables

CREATE TABLE IF NOT EXISTS orgs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id     BIGINT UNIQUE NOT NULL,
  login         TEXT NOT NULL,
  avatar_url    TEXT,
  plan          TEXT DEFAULT 'free',  -- 'free' | 'starter' | 'pro'
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
  failure_reason  TEXT,                    -- why a scan didn't complete
  credit_refunded BOOLEAN DEFAULT FALSE,   -- true when a claimed quota slot was refunded
  error_detail    TEXT,                    -- raw exception message; admin-only
  started_at      TIMESTAMPTZ,             -- start of the current attempt; re-stamped on retry
  reaped_at       TIMESTAMPTZ,             -- reaper tombstone; blocks later writes
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE scans ADD COLUMN IF NOT EXISTS gh_comment_id BIGINT;

-- Set once a quota slot is claimed so Bull retries never claim (and bill) twice.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS quota_claimed BOOLEAN DEFAULT FALSE;

-- 'skipped' = intentionally not run; 'failed' = pipeline errored. Neither may read as clean.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS failure_reason  TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS credit_refunded BOOLEAN DEFAULT FALSE;

-- Admin-only, capped ~2000 chars.
ALTER TABLE scans ADD COLUMN IF NOT EXISTS error_detail TEXT;

-- Reaper judges never-picked-up jobs by queue age and died-mid-run jobs by run age.
-- Once reaped_at is set, updateScanStatus refuses to write so a late worker can't resurrect it.
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

-- Links the installer to the org, so they see its repos from a personal GitHub account.
CREATE TABLE IF NOT EXISTS installations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_install_id   BIGINT UNIQUE NOT NULL,
  org_id              UUID REFERENCES orgs(id) ON DELETE CASCADE,
  installer_github_id BIGINT NOT NULL,   -- github_id of who clicked Install
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Runtime settings from /admin/settings. No secrets (keys stay in env).
-- RLS on with no policies = service role only.
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Migrations for existing deployments (no-ops on a fresh install)

ALTER TABLE findings ADD COLUMN IF NOT EXISTS affected_component    TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS exploitation_scenario TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS impact                TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS evidence              TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS confidence            TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS attacker_profile      TEXT;

-- Set only when a newer scan re-read the finding's file and no longer reproduced it;
-- a scan that never looked at the file must not retire it. See markStaleFindings().
ALTER TABLE findings ADD COLUMN IF NOT EXISTS is_stale BOOLEAN DEFAULT FALSE;

-- Points at the finding already on record for the same issue (another PR, or main); that one
-- is listed and alerted, this one only appears on its own PR. See saveFindings().
ALTER TABLE findings ADD COLUMN IF NOT EXISTS duplicate_of UUID REFERENCES findings(id) ON DELETE SET NULL;

-- Per-repo auth/rate-limit context injected into the scan prompt.
ALTER TABLE repos ADD COLUMN IF NOT EXISTS security_context TEXT;

-- Lets the security_context cache expire on a TTL even when no auth file changed.
ALTER TABLE repos ADD COLUMN IF NOT EXISTS security_context_updated_at TIMESTAMPTZ;

-- Monthly sweep quota for paid plans; free plan uses sweep_trials_used (lifetime trial).
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS sweep_count_month INT  DEFAULT 0;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS sweep_month       TEXT DEFAULT '';

-- Atomically claims a monthly sweep slot; FALSE when the limit is reached.
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

ALTER TABLE repos ADD COLUMN IF NOT EXISTS installation_id BIGINT;

-- Distinguishes "removed from installation" from "never scanned yet".
ALTER TABLE repos ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS default_branch   TEXT DEFAULT 'main';

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS paddle_customer_id       TEXT;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS paddle_subscription_id   TEXT;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS subscription_status      TEXT DEFAULT 'inactive';
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS scan_count_month         INT  DEFAULT 0;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS scan_month               TEXT DEFAULT '';  -- 'YYYY-MM'
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS sweep_trials_used        INT  DEFAULT 0;

-- Seed

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public_stats) THEN
    INSERT INTO public_stats (total_scans, total_findings, total_repos, critical_caught)
    VALUES (0, 0, 0, 0);
  END IF;
END $$;

-- Indexes

CREATE INDEX IF NOT EXISTS idx_scans_repo_id         ON scans(repo_id);
CREATE INDEX IF NOT EXISTS idx_scans_created_at      ON scans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_scan_id      ON findings(scan_id);
CREATE INDEX IF NOT EXISTS idx_findings_repo_id      ON findings(repo_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity     ON findings(severity);
CREATE INDEX IF NOT EXISTS idx_findings_is_resolved  ON findings(is_resolved);
CREATE INDEX IF NOT EXISTS idx_findings_is_stale     ON findings(is_stale);
CREATE INDEX IF NOT EXISTS idx_findings_duplicate_of ON findings(duplicate_of);
CREATE INDEX IF NOT EXISTS idx_findings_repo_file    ON findings(repo_id, file_path);
CREATE INDEX IF NOT EXISTS idx_installations_installer ON installations(installer_github_id);

-- RPC functions

-- Atomically claims a monthly scan slot; FALSE when the limit is reached.
-- FOR UPDATE closes the read-then-increment race.
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

  IF v_count >= p_limit THEN
    RETURN FALSE;
  END IF;

  UPDATE orgs
     SET scan_count_month = v_count + 1
   WHERE id = p_org_id;

  RETURN TRUE;
END;
$$;

-- Atomically refunds one sweep slot; FOR UPDATE prevents lost updates.
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

-- Atomically refunds one scan slot, only within the claim's billing month (p_month)
-- so a month rollover never underflows the counter.
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

-- Lifetime scan totals per org for the admin dashboard. Excludes quota_exceeded
-- ledger rows (never analysed), matching VISIBLE_SCAN_FILTER.
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
