-- Migration 001: per-scan token usage. Idempotent; run in the Supabase SQL editor.
-- tokens_in = prompt tokens, tokens_out = completion tokens.

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS tokens_in  INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_out INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_model   TEXT DEFAULT NULL;
