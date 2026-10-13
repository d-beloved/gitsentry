-- Migration 009: runtime app settings. Idempotent.
-- Keys: 'ai_vendor' {vendor} written by the admin page; 'ai_provider_status' written by the backend.
-- RLS with no policies: service role only.

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE app_settings IS 'Runtime settings edited from /admin/settings. No secrets — keys stay in env.';
