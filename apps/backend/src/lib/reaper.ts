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

// Closes out scans accepted but never finished as 'failed' with a refund. It never
// re-runs them: the diff isn't stored and a retry could post a duplicate review.

// Must clear the worst realistic queue wait (concurrency 1), not the worst scan.
const DEFAULT_QUEUE_MINUTES = 60;
// Measured from this attempt's pickup, so it bounds one run, not the retry chain.
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

// Avoids overlapping passes; claimStrandedScan already prevents double refunds.
let inFlight = false;

/** Returns scans this call closed out; ones another instance claimed first aren't counted. */
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
    const detail = scan.started_at
      ? `Stranded: picked up ${minutesSince(scan.started_at)}m ago and never finished — the worker died mid-run.`
      : `Stranded: still 'pending' ${ageMinutes}m after creation and never picked up — the queued job was dropped.`;

    try {
      const won = await claimStrandedScan(scan.id, detail);
      if (!won) continue;

      reaped++;

      const org = await getOrgByRepoId(scan.repo_id).catch(() => null);

      // Mirrors the worker's catch block.
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

// Unblocks a Pro PR waiting on our required check. Gated like the worker's
// postCheckRun so we never invent a check run elsewhere; fire-and-forget.
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

/** Disable with SCAN_REAPER=off. */
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
  timer.unref();

  console.log(
    `[reaper] Started — every ${intervalMinutes}m, reaping scans never picked up after ${queueMinutes}m or running over ${runMinutes}m`,
  );

  return timer;
}
