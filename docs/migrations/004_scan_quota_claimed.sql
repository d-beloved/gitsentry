-- Migration 004: quota-claim idempotency marker on scans
-- Run in Supabase SQL editor. Idempotent — safe to run more than once.
--
-- Why this exists: the scan worker claims a monthly quota slot
-- (try_claim_scan RPC) at the start of processing. When a job fails after
-- the claim (AI timeout, GitHub API error) Bull retries it, and the retry
-- claimed a second slot for the same scan — orgs were billed quota for
-- retries of a single scan. The worker now records the claim on the scan
-- row and skips re-claiming on retry.

ALTER TABLE scans ADD COLUMN IF NOT EXISTS quota_claimed BOOLEAN DEFAULT FALSE;
