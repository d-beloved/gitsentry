-- Migration 005: scan outcomes + credit refunds, so a scan that never ran can't read as clean. Idempotent.
-- 'skipped' = intentionally not run; 'failed' = pipeline error (claimed slot is refunded).

ALTER TABLE scans ADD COLUMN IF NOT EXISTS failure_reason  TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS credit_refunded BOOLEAN DEFAULT FALSE;

-- Atomically refunds one scan slot. FOR UPDATE prevents lost updates; only refunds
-- within the claim's billing month so a rollover never underflows.
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
