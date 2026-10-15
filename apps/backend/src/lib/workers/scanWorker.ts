import type Bull from "bull";
import { analyzeCode, AITimeoutError } from "../ai";
import {
  postPRReview,
  postCommitComment,
  postCheckRun,
  postUpgradeComment,
  postSkippedCheckRun,
  postIncompleteCheckRun,
  postSubscriptionPausedComment,
  hasRequiredCheck,
  setupBranchProtection,
  type SkippedScanReason,
} from "../github";
import { resolveSecurityContext } from "../securityContext";
import { extractScannablePaths } from "../differ";
import {
  saveFindings,
  updateScanStatus,
  getOrgByRepoId,
  tryClaimScan,
  getPreviousPRCommentId,
  getOpenPRFindings,
  updateScanCommentId,
  recordAiUsage,
  scanQuotaAlreadyClaimed,
  markScanQuotaClaimed,
  refundScanSlot,
  markScanStarted,
  getScanRefundState,
} from "../../db/queries";
import { notifyIfNeeded, notifyScanFailure } from "../notifier";
import { trackedElsewhere } from "../prComment";

// Paddle sets plan:"free" on lapse, so entitlement keys off status, not plan.
const LAPSED_SUBSCRIPTION_STATUSES = new Set(["canceled", "past_due", "payment_failed"]);
import type { ScanJobData, Finding } from "../../../../../packages/scanner-contract/types";

const SCAN_LIMITS: Record<string, number> = {free: 10, starter: 50, pro: 500};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[worker] ${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

export interface ProcessScanOptions {
  /** Refunds wait for the final attempt, else a later success is a free scan. Defaults to always final (inline path). */
  isFinalAttempt?: (err: unknown) => boolean;
}

// Every early return must resolve the required check, or the PR blocks forever.
// Fire-and-forget: a GitHub hiccup must not fail a benign skip.
function releaseCheck(
  target: {prNumber?: number | null; commitSha?: string | null},
  repoFullName: string,
  installationId: number,
  org: {plan?: string | null; subscription_status?: string | null} | null,
  reason: SkippedScanReason,
  quota?: {plan: string; limit: number},
): void {
  if (target.prNumber == null || !target.commitSha || !hasRequiredCheck(org)) return;
  postSkippedCheckRun(repoFullName, target.commitSha, installationId, reason, quota).catch(
    (err: Error) => console.error(`[worker] postSkippedCheckRun(${reason}) failed:`, err.message),
  );
}

export async function processScanJob(
  data: ScanJobData,
  options: ProcessScanOptions = {},
): Promise<void> {
  const isFinalAttempt = options.isFinalAttempt ?? ((): boolean => true);
  const {
    scanId,
    repoId,
    repoFullName,
    diff,
    context,
    installationId,
    prNumber,
    commitSha,
    branch,
    triggerType,
    quotaAlreadyClaimed,
  } = data;
  const startedAt = Date.now();

  // A reaped row was already refunded and reported failed. Return, don't throw:
  // a throw would retry and re-refund an already-terminal scan.
  if (!(await markScanStarted(scanId))) {
    console.warn(`[worker] Scan ${scanId} was reaped before pickup — abandoning`);
    return;
  }

  try {
    const org = await getOrgByRepoId(repoId);
    const isPro =
      org?.plan === "pro" &&
      (org?.subscription_status === "active" || org?.subscription_status == null);
    const scanLimit = SCAN_LIMITS[org?.plan ?? "free"] ?? SCAN_LIMITS.free;

    // Lapsed: record an explicit skip (never "clean"), no credit claimed.
    if (!quotaAlreadyClaimed && org?.subscription_status && LAPSED_SUBSCRIPTION_STATUSES.has(org.subscription_status)) {
      console.log(`[worker] Scan ${scanId} skipped: subscription ${org.subscription_status}`);
      await updateScanStatus(scanId, [], 0, "skipped", { failureReason: "subscription_inactive" });
      releaseCheck({prNumber, commitSha}, repoFullName, installationId, org, "subscription_inactive");
      // PRs are merging unscanned, so also comment; updated in place.
      if (prNumber != null) {
        (async () => {
          try {
            const existing = await getPreviousPRCommentId(repoId, prNumber);
            const commentId = await postSubscriptionPausedComment(
              repoFullName, prNumber, installationId, existing?.commentId ?? null,
            );
            await updateScanCommentId(scanId, commentId);
          } catch (err) {
            console.error("[worker] postSubscriptionPausedComment failed:", (err as Error).message);
          }
        })();
      }
      return;
    }

    // Callers that claimed atomically (rescan, issue_comment) set quotaAlreadyClaimed.
    if (!quotaAlreadyClaimed) {
      if (!org) {
        // Fail closed: without an org, quota can't be enforced.
        console.log(`[worker] Scan ${scanId} skipped: no org record (installation incomplete)`);
        await updateScanStatus(scanId, [], 0, "skipped", { failureReason: "no_org" });
        // Not gated on hasRequiredCheck: a stray grey check beats an unmergeable PR.
        if (prNumber != null && commitSha) {
          postSkippedCheckRun(repoFullName, commitSha, installationId, "no_org").catch(
            (err: Error) => console.error("[worker] postSkippedCheckRun(no_org) failed:", err.message),
          );
        }
        return;
      }
      // A Bull retry must not consume a second slot.
      const alreadyClaimed = await scanQuotaAlreadyClaimed(scanId);
      if (!alreadyClaimed) {
        const claimed = await tryClaimScan(
          org.id, scanLimit, org.plan ?? "free", org.scan_month ?? null,
          !!org.paddle_subscription_id,
        );
        if (!claimed) {
          console.log(
            `[worker] Scan ${scanId} skipped: ${org.plan ?? "free"} limit (${scanLimit}/month) reached`,
          );
          await updateScanStatus(scanId, [], 0, "skipped", { failureReason: "quota_exceeded" });
          releaseCheck({prNumber, commitSha}, repoFullName, installationId, org, "quota_exceeded", {
            plan: org.plan ?? "free",
            limit: scanLimit,
          });
          (async () => {
            try {
              const existingCommentId =
                prNumber != null ? (await getPreviousPRCommentId(repoId, prNumber))?.commentId ?? null : null;
              const commentId = await postUpgradeComment(
                repoFullName,
                {prNumber, commitSha},
                installationId,
                org.plan ?? "free",
                scanLimit,
                existingCommentId,
              );
              if (commentId) await updateScanCommentId(scanId, commentId);
            } catch (err) {
              console.error("[worker] upgrade comment failed:", (err as Error).message);
            }
          })();
          return;
        }
        await markScanQuotaClaimed(scanId);
      }
    }

    const { repoSecurityContext, classification } = await resolveSecurityContext({
      repoId,
      repoFullName,
      branch,
      installationId,
      diff,
      scanId,
    }).catch((err: Error) => {
      console.warn("[worker] resolveSecurityContext failed — scanning without it:", err.message);
      return { repoSecurityContext: "", classification: undefined };
    });

    if (classification) {
      console.log(
        `[worker] Classified ${repoFullName} as ${classification.project_type} (${classification.confidence}) — ${classification.reasoning}`,
      );
    }

    const { issues, summary, tokens_in, tokens_out, model_name, coverage } = await analyzeCode(diff, {
      ...context,
      repoSecurityContext,
    }, { classification });

    recordAiUsage({
      surface: "pr_scan",
      model: model_name ?? "",
      tokensIn: tokens_in ?? 0,
      tokensOut: tokens_out ?? 0,
      scanId,
      repoId,
    }).catch((err: Error) => console.error("[worker] recordAiUsage(pr_scan) failed:", err.message));

    // A `synchronize` scan reads only the incremental diff, usually a slice of the PR.
    const examinedPaths = extractScannablePaths(diff);

    const [saved, previousComment, priorOpen] = await Promise.all([
      issues.length > 0
        ? saveFindings(scanId, issues)
        : Promise.resolve([] as Awaited<ReturnType<typeof saveFindings>>),
      prNumber != null ? getPreviousPRCommentId(repoId, prNumber) : Promise.resolve(null),
      prNumber != null
        ? getOpenPRFindings(repoId, prNumber, scanId).catch((err: Error) => {
            console.error("[findings] getOpenPRFindings failed:", err.message);
            return [] as Finding[];
          })
        : Promise.resolve([] as Finding[]),
    ]);

    // An issue already dismissed elsewhere stays off this PR too.
    const findings = saved.filter((f) => !f.is_false_positive);

    // Findings in files this scan didn't re-read carry forward rather than vanish.
    const examined = new Set(examinedPaths);
    const reportedNow = new Set(findings.map((f) => f.file_path));
    const carried = priorOpen.filter(
      (f) => !examined.has(f.file_path) && !reportedNow.has(f.file_path),
    );

    if (carried.length) {
      console.log(
        `[worker] Scan ${scanId} carrying ${carried.length} open finding(s) in files it did not re-read: ${[
          ...new Set(carried.map((f) => f.file_path)),
        ].join(", ")}`,
      );
    }

    if (prNumber != null) {
      const existingCommentId = previousComment?.commentId ?? null;

      // findings_count alone misses carried findings shown with count 0, which
      // would freeze the comment on a since-fixed finding.
      const commentShowsFindings = !!previousComment?.hadFindings || priorOpen.length > 0;

      const skipCleanUpdate =
        findings.length === 0 &&
        carried.length === 0 &&
        !!existingCommentId &&
        !commentShowsFindings;
      if (!skipCleanUpdate) {
        const trackedIn = await trackedElsewhere([...findings, ...carried], prNumber);
        const commentId = await withTimeout(
          postPRReview(repoFullName, prNumber, findings, carried, summary, scanId, installationId, existingCommentId, coverage, trackedIn),
          30_000,
          "postPRReview",
        );
        updateScanCommentId(scanId, commentId).catch((err: Error) =>
          console.error("[worker] updateScanCommentId failed:", err.message),
        );
      }
    } else if (commitSha) {
      await withTimeout(
        postCommitComment(repoFullName, commitSha, findings, summary, scanId, installationId),
        30_000,
        "postCommitComment",
      );
    }

    // Issues already on record from another PR or branch were alerted on then.
    const fresh = findings.filter((f) => !f.duplicate_of);
    if (fresh.length > 0) {
      await withTimeout(
        notifyIfNeeded(repoId, repoFullName, fresh, triggerType, branch, scanId),
        30_000,
        "notifyIfNeeded",
      );
    }

    if (prNumber != null && commitSha && isPro) {
      // Lazy setup for repos installationRepositories never saw.
      setupBranchProtection(repoFullName, branch ?? "main", installationId).catch(
        (err: Error) =>
          console.error("[worker] lazy branch protection setup failed:", err.message),
      );
      postCheckRun(repoFullName, commitSha, findings, carried, installationId).catch((err: Error) =>
        console.error("[worker] check run failed:", err.message),
      );
    }

    await updateScanStatus(scanId, findings, Date.now() - startedAt, "complete", {
      tokensIn: tokens_in ?? 0,
      tokensOut: tokens_out ?? 0,
      modelName: model_name,
      examinedPaths,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[worker] Scan ${scanId} failed:`, errorMessage);

    // A pipeline failure must never cost the customer a scan.
    const org = await getOrgByRepoId(repoId).catch(() => null);

    // One refund per claimed slot, ever: credit_refunded stops a later attempt
    // or the reaper from releasing the same slot twice.
    const refundState = await getScanRefundState(scanId).catch(() => ({
      quotaClaimed: false,
      creditRefunded: true,
    }));
    const slotClaimed = quotaAlreadyClaimed || refundState.quotaClaimed;
    // Hold the slot while a retry is still coming.
    const finalAttempt = isFinalAttempt(err);
    const shouldRefund =
      finalAttempt && !!org && slotClaimed && !refundState.creditRefunded;
    if (!finalAttempt) {
      console.log(
        `[worker] Scan ${scanId} failed but will be retried — holding its quota slot`,
      );
    }

    // Status first: it's the guarded write, false if the reaper already owns
    // (and refunded) the row.
    const written = await updateScanStatus(scanId, [], Date.now() - startedAt, "failed", {
      failureReason: "pipeline_error",
      creditRefunded: shouldRefund,
      errorDetail: errorMessage,
    }).catch(() => false);

    let creditRefunded = false;
    if (written && shouldRefund && org) {
      await refundScanSlot(
        org.id, org.plan ?? "free", org.scan_month ?? null,
        !!org.paddle_subscription_id,
      ).catch(() => {});
      creditRefunded = true;
    }

    if (creditRefunded) {
      notifyScanFailure(repoId, repoFullName, "pipeline_error", true, scanId).catch((e: Error) =>
        console.error("[worker] notifyScanFailure failed:", e.message),
      );
    }

    // Unlike skips, a failed scan holds the gate. Final attempt only, so a red
    // check doesn't sit beside a later attempt's success.
    if (finalAttempt && prNumber != null && commitSha && hasRequiredCheck(org)) {
      postIncompleteCheckRun(repoFullName, commitSha, installationId, creditRefunded).catch(
        (e: Error) => console.error("[worker] postIncompleteCheckRun failed:", e.message),
      );
    }

    throw err;
  }
}

// A timeout will recur on identical input and stall the queue, so don't retry.
// Parse failures are transient and keep their retries.
function isTerminalScanError(err: unknown): boolean {
  return err instanceof AITimeoutError;
}

export default async function scanWorkerProcessor(
  job: Bull.Job<ScanJobData>,
): Promise<void> {
  // Bull increments attemptsMade only after a throw, so it's 0 on the first run.
  const maxAttempts = job.opts?.attempts ?? 1;
  const lastAttempt = job.attemptsMade + 1 >= maxAttempts;

  try {
    await processScanJob(job.data, {
      isFinalAttempt: (err) => lastAttempt || isTerminalScanError(err),
    });
  } catch (err) {
    if (isTerminalScanError(err)) {
      console.warn(
        `[worker] Job ${job.id} hit a terminal error — not retrying: ${(err as Error).message}`,
      );
      // discard() only sets a flag; the throw below still fails the job.
      job.discard();
    }
    throw err;
  }
}
