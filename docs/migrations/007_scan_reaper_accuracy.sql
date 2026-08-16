-- Migration 007: reaper accuracy — tell "never picked up" apart from "died mid-run"
-- Run in Supabase SQL editor. Idempotent — safe to run more than once.
--
-- The reaper (migration-less, lib/reaper.ts) decided a scan was stranded purely
-- from `created_at`, i.e. enqueue time. That cannot distinguish a job Redis
-- dropped from one that is legitimately still queued behind a backlog. With the
-- Bull worker at concurrency 1, a single scan that hits the AI timeout occupies
-- the queue for ~6 minutes across its retries, so a burst of PRs pushes later
-- scans past the 15-minute threshold while they are still perfectly healthy.
-- Those got marked 'failed' and refunded, and then the worker ran them anyway
-- and flipped the row back to 'complete' — a failure notification and a refund
-- for a scan that actually succeeded.
--
--   started_at  — stamped when the worker picks the job up (re-stamped on each
--                 Bull retry, so it always means "this attempt began at"). Lets
--                 the reaper use two different thresholds:
--                   started_at IS NULL  -> never consumed; judge by queue age
--                   started_at IS NOT NULL -> worker died mid-run; judge by run age
--
--   reaped_at   — set by the reaper when it closes a row out. Acts as a tombstone:
--                 updateScanStatus refuses to write to a reaped row, so a late
--                 worker can no longer resurrect a refunded scan into 'complete'.
--                 A NULL reaped_at is the normal case, including for scans that
--                 failed and are being retried — retries must still be able to
--                 overwrite their own earlier failure.

ALTER TABLE scans ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS reaped_at  TIMESTAMPTZ;

-- The reaper polls for pending rows every 5 minutes. Partial index keeps that
-- sweep off a full scan of the table as the history grows.
CREATE INDEX IF NOT EXISTS idx_scans_pending_reaper
  ON scans (created_at)
  WHERE status = 'pending';
