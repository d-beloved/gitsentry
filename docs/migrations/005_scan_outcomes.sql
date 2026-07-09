-- Migration 005: truthful scan outcomes + scan-credit refunds
-- Run in Supabase SQL editor. Idempotent — safe to run more than once.
--
-- Why this exists: a scan that never ran (quota exhausted, subscription
-- lapsed, no org record) was written as status='failed', findings_count=0 —
-- indistinguishable on the dashboard from a genuinely clean pass, so users
-- and admins saw "clean" when no scan actually happened. We now record *why*
-- a scan didn't complete, and distinguish a benign skip from a real failure:
--
--   status 'skipped'  — nothing wrong, the scan was intentionally not run
--                       (failure_reason: quota_exceeded | subscription_inactive
--                        | no_org | no_diff)
--   status 'failed'   — the pipeline errored (failure_reason: pipeline_error |
--                       ai_error). If a quota slot had already been claimed we
--                       refund it (credit_refunded=true) so a genuine failure
--                       never costs the customer a scan.
--
-- `status` stays a free-text column, so no enum change is needed to start
-- using the new 'skipped' value.

ALTER TABLE scans ADD COLUMN IF NOT EXISTS failure_reason  TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS credit_refunded BOOLEAN DEFAULT FALSE;

-- Atomically refunds one monthly scan slot (e.g. when a scan errors after
-- claiming its quota slot but before producing results). Mirrors refund_sweep:
-- FOR UPDATE guards the same lost-update race that try_claim_scan guards on the
-- claim side, and we only decrement when the org is still inside the billing
-- month the slot was claimed in (so a month rollover never underflows).
CREATE OR REPLACE FUNCTION refund_scan(p_org_id UUID, p_month TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INT;
  v_month TEXT;
BEGIN
  SELECT scan_count_month, scan_month
    INTO v_count, v_month
    FROM orgs
   WHERE id = p_org_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Only refund inside the same billing month the slot was claimed in.
  IF v_month IS DISTINCT FROM p_month THEN
    RETURN;
  END IF;

  IF v_count > 0 THEN
    UPDATE orgs
       SET scan_count_month = v_count - 1
     WHERE id = p_org_id;
  END IF;
END;
$$;
