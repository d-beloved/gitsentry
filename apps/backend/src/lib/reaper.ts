import {
  getStrandedScans,
  claimStrandedScan,
  markScanCreditRefunded,
  getOrgByRepoId,
  refundScanSlot,
} from "../db/queries";
import { notifyScanFailure } from "./notifier";

/**
 * Stranded-scan reaper.
 *
 * saveScan() writes a 'pending' row before dispatchScan() hands the job to Bull.
 * dispatchScan already falls back to inline processing when the *enqueue* fails,
 * but nothing covers a job that was accepted and then never consumed — Redis
 * throttled mid-flight, a non-persistent Redis restarting and dropping the
 * queue, or the worker process being killed between pickup and completion. Those
 * rows sit at 'pending' forever: the customer spent a credit and the dashboard
 * shows a scan that never resolves.
 *
 * The reaper deliberately does not re-run the scan. Re-running needs the diff,
 * which isn't stored on the row, and a retry that reached the comment stage
 * could post a duplicate PR review. Instead it closes the row out truthfully —
 * 'failed' with a refund — which is the same contract the worker's own catch
 * block honours, and leaves the customer free to trigger a rescan.
 */

const DEFAULT_STRAND_MINUTES = 15;
const DEFAULT_INTERVAL_MINUTES = 5;
const BATCH_LIMIT = 50;

function envMinutes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[reaper] ${name}="${raw}" is not a positive number — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

// Guards against a slow pass overlapping the next tick, which would double-read
// the same batch. The claim in claimStrandedScan makes double-refunds impossible
// anyway; this just avoids the wasted work.
let inFlight = false;

/**
 * One reaper pass. Returns the number of scans actually closed out by this
 * call — scans another instance (or a late worker) resolved first aren't
 * counted, because this process didn't win the claim.
 */
export async function reapStrandedScans(): Promise<number> {
  const strandMinutes = envMinutes("SCAN_STRAND_TIMEOUT_MINUTES", DEFAULT_STRAND_MINUTES);
  const cutoff = new Date(Date.now() - strandMinutes * 60_000).toISOString();

  const stranded = await getStrandedScans(cutoff, BATCH_LIMIT);
  if (stranded.length === 0) return 0;

  console.warn(
    `[reaper] Found ${stranded.length} scan(s) stuck in 'pending' for over ${strandMinutes}m`,
  );

  let reaped = 0;

  for (const scan of stranded) {
    const repoFullName = scan.repos?.full_name ?? scan.repo_id;
    const ageMinutes = Math.round((Date.now() - new Date(scan.created_at).getTime()) / 60_000);

    try {
      const won = await claimStrandedScan(
        scan.id,
        `Stranded: still 'pending' ${ageMinutes}m after creation — the queued job was never processed to completion.`,
      );
      // Someone else closed it out between the read and the update.
      if (!won) continue;

      reaped++;

      // Refund only if this scan actually consumed a slot and hasn't already
      // been refunded. Mirrors the worker's catch block.
      let creditRefunded = false;
      if (scan.quota_claimed && !scan.credit_refunded) {
        const org = await getOrgByRepoId(scan.repo_id).catch(() => null);
        if (org) {
          await refundScanSlot(org.id, org.plan ?? "free", org.scan_month ?? null).catch(() => {});
          await markScanCreditRefunded(scan.id);
          creditRefunded = true;
        }
      }

      console.warn(
        `[reaper] Reaped scan ${scan.id} (${repoFullName}, ${ageMinutes}m old)` +
          `${creditRefunded ? " — credit refunded" : ""}`,
      );

      if (creditRefunded) {
        notifyScanFailure(scan.repo_id, repoFullName, "pipeline_error", true, scan.id).catch(
          (e: Error) => console.error("[reaper] notifyScanFailure failed:", e.message),
        );
      }
    } catch (err) {
      // One bad row must not stop the rest of the batch.
      console.error(`[reaper] Failed to reap scan ${scan.id}:`, (err as Error).message);
    }
  }

  return reaped;
}

/**
 * Starts the periodic reaper. Disable with SCAN_REAPER=off. Returns the timer so
 * tests (and any future graceful-shutdown path) can clear it.
 */
export function startReaper(): NodeJS.Timeout | null {
  if (process.env.SCAN_REAPER === "off") {
    console.log("[reaper] Disabled via SCAN_REAPER=off");
    return null;
  }

  const intervalMinutes = envMinutes("SCAN_REAPER_INTERVAL_MINUTES", DEFAULT_INTERVAL_MINUTES);
  const strandMinutes = envMinutes("SCAN_STRAND_TIMEOUT_MINUTES", DEFAULT_STRAND_MINUTES);

  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    reapStrandedScans()
      .catch((err: Error) => console.error("[reaper] pass failed:", err.message))
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = setInterval(tick, intervalMinutes * 60_000);
  // Don't hold the event loop open on shutdown.
  timer.unref();

  console.log(
    `[reaper] Started — every ${intervalMinutes}m, reaping scans pending over ${strandMinutes}m`,
  );

  return timer;
}
