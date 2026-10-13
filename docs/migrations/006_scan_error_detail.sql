-- Migration 006: raw error message (~2000 chars) on failed scans. Idempotent.
-- Admin-only; never returned by a customer-facing API.

ALTER TABLE scans ADD COLUMN IF NOT EXISTS error_detail TEXT;
