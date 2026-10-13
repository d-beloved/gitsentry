-- Migration 007: started_at (per attempt) lets the reaper tell "never picked up" from "died mid-run".
-- reaped_at is a tombstone: a late worker must not resurrect a reaped scan. Idempotent.

ALTER TABLE scans ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS reaped_at  TIMESTAMPTZ;

-- Partial index for the reaper's 5-minute poll of pending rows.
CREATE INDEX IF NOT EXISTS idx_scans_pending_reaper
  ON scans (created_at)
  WHERE status = 'pending';
