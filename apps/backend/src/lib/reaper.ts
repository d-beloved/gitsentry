import {
  getStrandedScans,
  claimStrandedScan,
  markScanCreditRefunded,
  getOrgByRepoId,
  refundScanSlot,
} from "../db/queries";
import { notifyScanFailure } from "./notifier";
import { postIncompleteCheckRun } from "./github";
import type { StrandedScanRow } from "../db/queries";
import type { OrgWithUsage } from "../db/types";

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
 *
 * Closing out means GitHub too, not just the database. A Pro repo has our check
 * as a required status check, so a PR scan that dies leaves the PR waiting on a
 * status that will never be reported. See closeOutCheckRun.
 *
 * Two clocks, not one (migration 007). Judging every row by `created_at` could
 * not tell a dropped job from one legitimately queued behind a backlog, and with
 * the Bull worker at concurrency 1 that backlog is real — one scan hitting the AI
 * timeout holds the queue for minutes. Reaping a healthy queued scan refunded a
 * credit and sent a failure notice for a scan that then completed normally. So a
 * row that was never picked up (started_at IS NULL) is judged by queue age with a
 * deliberately generous threshold, and one whose worker died mid-run is judged by
 * run age. Should a healthy scan still be reaped past even the queue threshold,
 * reaped_at stops the worker from resurrecting the row — see markScanStarted.
 */

// How long a job may sit unclaimed in the queue before we call it dropped. This
// has to clear the worst realistic queue wait, not the worst scan: the Bull
// worker runs at concurrency 1, so a backlog of slow scans legitimately keeps
// later ones 'pending' for a long time, and reaping one of those refunds a scan
// that then goes on to succeed.
const DEFAULT_QUEUE_MINUTES = 60;
// How long a single attempt may run before we call the worker dead. Measured
// from this attempt's pickup, so it bounds one run, not the whole retry chain —
// no healthy scan comes close, which is why it can stay tight.
const DEFAULT_RUN_MINUTES = 15;
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
  const queueMinutes = envMinutes("SCAN_QUEUE_TIMEOUT_MINUTES", DEFAULT_QUEUE_MINUTES);
  const runMinutes = envMinutes("SCAN_STRAND_TIMEOUT_MINUTES", DEFAULT_RUN_MINUTES);
  const now = Date.now();
  const queueCutoff = new Date(now - queueMinutes * 60_000).toISOString();
  const runCutoff = new Date(now - runMinutes * 60_000).toISOString();

  const stranded = await getStrandedScans(queueCutoff, runCutoff, BATCH_LIMIT);
  if (stranded.length === 0) return 0;

  console.warn(
    `[reaper] Found ${stranded.length} stranded scan(s) — never picked up after ${queueMinutes}m, or running over ${runMinutes}m`,
  );

  let reaped = 0;
  const minutesSince = (iso: string): number =>
    Math.round((Date.now() - new Date(iso).getTime()) / 60_000);

  for (const scan of stranded) {
    const repoFullName = scan.repos?.full_name ?? scan.repo_id;
    const ageMinutes = minutesSince(scan.created_at);
    // Which clock caught it decides what actually went wrong, and the admin
    // reading error_detail later needs that distinction to act on it.
    const detail = scan.started_at
      ? `Stranded: picked up ${minutesSince(scan.started_at)}m ago and never finished — the worker died mid-run.`
      : `Stranded: still 'pending' ${ageMinutes}m after creation and never picked up — the queued job was dropped.`;

    try {
      const won = await claimStrandedScan(scan.id, detail);
      // Someone else closed it out between the read and the update.
      if (!won) continue;

      reaped++;

      // One org read per scan, shared by the refund and the check run below.
      const org = await getOrgByRepoId(scan.repo_id).catch(() => null);

      // Refund only if this scan actually consumed a slot and hasn't already
      // been refunded. Mirrors the worker's catch block.
      let creditRefunded = false;
      if (scan.quota_claimed && !scan.credit_refunded) {
        if (org) {
          await refundScanSlot(
            org.id, org.plan ?? "free", org.scan_month ?? null,
            !!org.paddle_subscription_id,
          ).catch(() => {});
          await markScanCreditRefunded(scan.id);
          creditRefunded = true;
        }
      }

      closeOutCheckRun(scan, org, creditRefunded);

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
 * Tell GitHub the scan is over, for the one case where a check run is pending on
 * it: a PR scan on a Pro repo. Those repos have "Gitsentry Security Scan" as a
 * required check, and the worker only ever posts that check run on the success
 * path — so a reaped scan leaves the PR blocked on a status that will now never
 * arrive. Closing the row out in the database without closing out the check run
 * fixes the dashboard and leaves the customer's PR stuck.
 *
 * Gated exactly like the worker's own postCheckRun call (PR + head sha + Pro),
 * because posting anywhere else would create a check run that never otherwise
 * existed — and on a repo with branch protection, inventing a red required check
 * is its own outage.
 *
 * Fire-and-forget: GitHub being unreachable must not cost us the reap, which is
 * already committed in the database by this point.
 */
function closeOutCheckRun(
  scan: StrandedScanRow,
  org: OrgWithUsage | null,
  creditRefunded: boolean,
): void {
  const isPro =
    org?.plan === "pro" &&
    (org.subscription_status === "active" || org.subscription_status == null);
  const installationId = scan.repos?.installation_id;
  const repoFullName = scan.repos?.full_name;

  if (
    !isPro ||
    !installationId ||
    !repoFullName ||
    scan.trigger_type !== "pull_request" ||
    !scan.commit_sha
  ) {
    return;
  }

  postIncompleteCheckRun(repoFullName, scan.commit_sha, installationId, creditRefunded)
    .then(() =>
      console.warn(
        `[reaper] Closed out check run for ${repoFullName}#${scan.trigger_ref} @ ${scan.commit_sha.slice(0, 7)}`,
      ),
    )
    .catch((err: Error) =>
      console.error(`[reaper] postIncompleteCheckRun failed for scan ${scan.id}:`, err.message),
    );
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
  const queueMinutes = envMinutes("SCAN_QUEUE_TIMEOUT_MINUTES", DEFAULT_QUEUE_MINUTES);
  const runMinutes = envMinutes("SCAN_STRAND_TIMEOUT_MINUTES", DEFAULT_RUN_MINUTES);

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
    `[reaper] Started — every ${intervalMinutes}m, reaping scans never picked up after ${queueMinutes}m or running over ${runMinutes}m`,
  );

  return timer;
}
