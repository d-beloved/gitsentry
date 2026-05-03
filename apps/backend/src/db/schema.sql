-- Run this against your Supabase project to create the GitSentry schema.

-- organisations (GitHub orgs or individual accounts)
CREATE TABLE orgs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id     BIGINT UNIQUE NOT NULL,
  login         TEXT NOT NULL,
  avatar_url    TEXT,
  plan          TEXT DEFAULT 'free',  -- 'free' | 'pro' | 'team'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- repositories connected to GitSentry
CREATE TABLE repos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID REFERENCES orgs(id) ON DELETE CASCADE,
  github_id       BIGINT UNIQUE NOT NULL,
  full_name       TEXT NOT NULL,       -- e.g. 'acme/backend'
  default_branch  TEXT DEFAULT 'main',
  is_active       BOOLEAN DEFAULT TRUE,
  watch_prs       BOOLEAN DEFAULT TRUE,
  watch_pushes    BOOLEAN DEFAULT TRUE,
  watch_main      BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- individual scan events (one per PR or push)
CREATE TABLE scans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID REFERENCES repos(id) ON DELETE CASCADE,
  trigger_type    TEXT NOT NULL,        -- 'pull_request' | 'push' | 'push_main' | 'push_branch'
  trigger_ref     TEXT NOT NULL,        -- PR number or branch name
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
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- individual security findings
CREATE TABLE findings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id         UUID REFERENCES scans(id) ON DELETE CASCADE,
  repo_id         UUID REFERENCES repos(id) ON DELETE CASCADE,
  severity        TEXT NOT NULL,        -- 'critical' | 'high' | 'medium' | 'low'
  category        TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  line_number     INT,
  code_snippet    TEXT,
  description     TEXT NOT NULL,
  fix_suggestion  TEXT NOT NULL,
  is_false_positive BOOLEAN DEFAULT FALSE,
  is_resolved     BOOLEAN DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- users (GitHub OAuth)
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id       BIGINT UNIQUE NOT NULL,
  login           TEXT NOT NULL,
  email           TEXT,
  avatar_url      TEXT,
  org_id          UUID REFERENCES orgs(id),
  role            TEXT DEFAULT 'member', -- 'owner' | 'member'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- alert configuration per repo
CREATE TABLE alert_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID REFERENCES repos(id) ON DELETE CASCADE,
  slack_webhook   TEXT,
  email           TEXT,
  min_severity    TEXT DEFAULT 'high',  -- minimum severity to alert on
  alert_on_main   BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- public aggregate stats (cached, updated every 5 mins)
CREATE TABLE public_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_scans     BIGINT DEFAULT 0,
  total_findings  BIGINT DEFAULT 0,
  total_repos     BIGINT DEFAULT 0,
  critical_caught BIGINT DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed an initial stats row
INSERT INTO public_stats (total_scans, total_findings, total_repos, critical_caught)
VALUES (0, 0, 0, 0);

-- Indexes for common query patterns
CREATE INDEX idx_scans_repo_id ON scans(repo_id);
CREATE INDEX idx_scans_created_at ON scans(created_at DESC);
CREATE INDEX idx_findings_scan_id ON findings(scan_id);
CREATE INDEX idx_findings_repo_id ON findings(repo_id);
CREATE INDEX idx_findings_severity ON findings(severity);
CREATE INDEX idx_findings_is_resolved ON findings(is_resolved);
