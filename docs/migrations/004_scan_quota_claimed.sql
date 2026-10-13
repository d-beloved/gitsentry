-- Migration 004: quota-claim marker so a Bull retry never claims a second slot for the same scan.
-- Idempotent.

ALTER TABLE scans ADD COLUMN IF NOT EXISTS quota_claimed BOOLEAN DEFAULT FALSE;
