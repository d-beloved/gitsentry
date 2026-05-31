-- Migration 001: Token tracking on scans
-- Run in Supabase SQL editor (Dashboard → SQL Editor → New query → Run).
-- Idempotent — safe to run on an existing database.
--
-- Adds per-scan token usage columns so you can monitor AI API consumption.
-- tokens_in  = prompt tokens sent to the AI model
-- tokens_out = completion tokens returned by the AI model

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS tokens_in  INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_out INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_model   TEXT DEFAULT NULL;
