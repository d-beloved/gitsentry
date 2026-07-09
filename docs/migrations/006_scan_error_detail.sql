-- Migration 006: raw error detail on failed scans
-- Run in Supabase SQL editor. Idempotent — safe to run more than once.
--
-- `failure_reason` (migration 005) only stores a coarse category (e.g.
-- "pipeline_error"), which told admins THAT a scan failed but not WHY —
-- they had to go dig through Render logs to see the actual exception message.
-- error_detail stores that raw message (capped at ~2000 chars) so the admin
-- scans page can show it directly. Admin-only surface (behind requireAdmin()),
-- never returned by any customer-facing API response.

ALTER TABLE scans ADD COLUMN IF NOT EXISTS error_detail TEXT;
