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

// Subscription states that mean the org is no longer entitled to scans. Paddle
// sets plan:"free" on lapse, so we key entitlement off the status, not the plan.
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
  /**
   * Whether no further attempt will follow this failure. Refunds are deferred to
   * the final attempt, because a slot released on attempt 1 is never re-taken
   * when attempt 2 succeeds — the success path writes no credit_refunded value,
   * so the column keeps the refund and the customer gets a completed scan for
   * free. Deciding this per-error rather than up front lets a discarded
   * (non-retryable) failure count as final even when attempts remain.
   *
   * Defaults to "always final", which is correct for the inline path in
   * dispatchScan: that runs once and is never retried.
   */
  isFinalAttempt?: (err: unknown) => boolean;
}

/**
 * Resolve the required check for a PR we are about to walk away from.
 *
 * Every early return below leaves a Pro PR sitting on "Expected — waiting for
 * status to be reported", because the only check run we post on the happy path
 * is the completed one at the end. Silence does not fail open here; it blocks
 * the merge exactly as hard as a red check would, just without telling anyone
 * why. See postSkippedCheckRun for why these resolve as neutral rather than
 * holding the gate.
 *
 * Fire-and-forget: a GitHub hiccup must not turn a benign skip into a failed job.
 */
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

  // Stamp this attempt's pickup time and check we still own the scan. A row the
  // reaper already closed out has been refunded and reported as failed to the
  // customer; finishing it would post a PR review for a scan they were told
  // didn't run. Return rather than throw — throwing would send it back through
  // Bull's retry and the refund path below, both of which are wrong for a scan
  // that is already terminal.
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

    // Entitlement: a lapsed subscription means the org isn't entitled to this
    // scan. Record it as an explicit skip (not "failed", not silently "clean")
    // and don't claim a credit. Only applies when the caller hasn't already
    // claimed a slot (e.g. a manual rescan the user paid for).
    if (!quotaAlreadyClaimed && org?.subscription_status && LAPSED_SUBSCRIPTION_STATUSES.has(org.subscription_status)) {
      console.log(`[worker] Scan ${scanId} skipped: subscription ${org.subscription_status}`);
      await updateScanStatus(scanId, [], 0, "skipped", { failureReason: "subscription_inactive" });
      releaseCheck({prNumber, commitSha}, repoFullName, installationId, org, "subscription_inactive");
      // A grey check nobody expands is disclosure, not notification, and this is
      // the state where the customer most needs to know: their PRs are merging
      // unscanned. The comment is updated in place, so a busy PR gets one.
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

    // Claim a scan slot for all plans (including Pro, which is capped at 500/month).
    // Skip when the caller already claimed atomically (rescan endpoint, issue_comment
    // webhook) to prevent double-counting.
    // When org is null (public repo with no DB record yet) treat as anonymous free tier.
    if (!quotaAlreadyClaimed) {
      if (!org) {
        // No org record means we cannot enforce per-org quota — fail closed to prevent
        // unlimited free scans on public repos that never completed installation setup.
        console.log(`[worker] Scan ${scanId} skipped: no org record (installation incomplete)`);
        await updateScanStatus(scanId, [], 0, "skipped", { failureReason: "no_org" });
        // Deliberately not behind hasRequiredCheck: with no org record we cannot
        // tell whether this repo carries our required check, and the cost of
        // guessing wrong is asymmetric — a stray grey check on a broken install
        // against a PR nobody can ever merge.
        if (prNumber != null && commitSha) {
          postSkippedCheckRun(repoFullName, commitSha, installationId, "no_org").catch(
            (err: Error) => console.error("[worker] postSkippedCheckRun(no_org) failed:", err.message),
          );
        }
        return;
      }
      // Idempotency: a Bull retry of a job that already claimed its slot (then
      // failed later in the pipeline) must not consume a second one.
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

    // Stage 1 — security context (cached, refreshed on auth-file touch or TTL
    // expiry) + project classifier (always re-run, cheap). See securityContext.ts.
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

    // The files this scan actually read. A `synchronize` scan sees only the
    // incremental diff, so this is usually a slice of the PR, not all of it.
    const examinedPaths = extractScannablePaths(diff);

    const [findings, previousComment, priorOpen] = await Promise.all([
      issues.length > 0
        ? saveFindings(scanId, issues)
        : Promise.resolve([] as Awaited<ReturnType<typeof saveFindings>>),
      prNumber != null ? getPreviousPRCommentId(repoId, prNumber) : Promise.resolve(null),
      prNumber != null
        ? getOpenPRFindings(repoId, prNumber, scanId)
        : Promise.resolve([] as Finding[]),
    ]);

    // Anything this scan re-read is settled by this scan's result: it either
    // came back in `issues` or it is genuinely gone. Everything else was never
    // looked at, so it carries forward rather than silently disappearing.
    // The two sets are disjoint by construction — `findings` come from files in
    // the diff, `carried` from files outside it — so there is nothing to dedupe
    // beyond guarding against a path the model invented.
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

      // Did the comment as it currently stands show any issues? The prior
      // scan's own findings_count is not enough: a scan that reported nothing
      // itself but reprinted carried findings writes findings_count = 0 while
      // displaying issues. Missing that would leave the comment frozen on a
      // finding that has since been fixed, because the update would be skipped
      // as "clean → clean".
      const commentShowsFindings = !!previousComment?.hadFindings || priorOpen.length > 0;

      // Skip only when there is nothing to say and the comment already says it.
      const skipCleanUpdate =
        issues.length === 0 &&
        carried.length === 0 &&
        !!existingCommentId &&
        !commentShowsFindings;
      if (!skipCleanUpdate) {
        const commentId = await withTimeout(
          postPRReview(repoFullName, prNumber, findings, carried, summary, scanId, installationId, existingCommentId, coverage),
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

    if (issues.length > 0) {
      await withTimeout(
        notifyIfNeeded(repoId, repoFullName, findings, triggerType, branch, scanId),
        30_000,
        "notifyIfNeeded",
      );
    }

    // Check Run — Pro plan only
    if (prNumber != null && commitSha && isPro) {
      // Lazily ensure branch protection is set up for repos that existed before
      // the auto-setup feature was deployed (installationRepositories only covers
      // repos added after deployment).
      setupBranchProtection(repoFullName, branch ?? "main", installationId).catch(
        (err: Error) =>
          console.error("[worker] lazy branch protection setup failed:", err.message),
      );
      postCheckRun(repoFullName, commitSha, findings, carried, installationId).catch((err: Error) =>
        console.error("[worker] check run failed:", err.message),
      );
    }

    await updateScanStatus(scanId, issues, Date.now() - startedAt, "complete", {
      tokensIn: tokens_in ?? 0,
      tokensOut: tokens_out ?? 0,
      modelName: model_name,
      examinedPaths,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[worker] Scan ${scanId} failed:`, errorMessage);

    // A scan that consumed a quota slot and then errored gets that slot back, so
    // a pipeline failure never costs the customer a scan.
    const org = await getOrgByRepoId(repoId).catch(() => null);

    // One refund per claimed slot, ever. quotaAlreadyClaimed covers the callers
    // that claim atomically before dispatch (rescan, issue_comment) — those never
    // set quota_claimed on the row — while credit_refunded stops a second Bull
    // attempt, or the reaper, from releasing the same slot twice. Without that
    // second check three failed attempts refunded three credits for one claim.
    const refundState = await getScanRefundState(scanId).catch(() => ({
      quotaClaimed: false,
      creditRefunded: true,
    }));
    const slotClaimed = quotaAlreadyClaimed || refundState.quotaClaimed;
    // Hold the slot while a retry is still coming. Refunding now and completing
    // on the next attempt is exactly how a depleted plan handed out free scans.
    const finalAttempt = isFinalAttempt(err);
    const shouldRefund =
      finalAttempt && !!org && slotClaimed && !refundState.creditRefunded;
    if (!finalAttempt) {
      console.log(
        `[worker] Scan ${scanId} failed but will be retried — holding its quota slot`,
      );
    }

    // Write the terminal status before refunding, because it is the guarded
    // write: a row the reaper already took ownership of returns false here, and
    // we skip a refund it has by definition already made.
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

    // The gate holds here, unlike the skips above: we tried to establish this
    // PR's security state and could not, which is exactly what a required check
    // is for. It blocks no harder than the silence it replaces — an unreported
    // required check already blocks — but it says so, and its Re-run button is
    // wired to handleCheckRun. Only on the last attempt: a red check posted on
    // attempt 1 would sit in the PR's check list next to attempt 3's success.
    if (finalAttempt && prNumber != null && commitSha && hasRequiredCheck(org)) {
      postIncompleteCheckRun(repoFullName, commitSha, installationId, creditRefunded).catch(
        (e: Error) => console.error("[worker] postIncompleteCheckRun failed:", e.message),
      );
    }

    throw err;
  }
}

/**
 * Errors that a retry cannot fix. The job data is identical on every attempt, so
 * a prompt that blew the wall-clock budget once will blow it again — and with the
 * Bull worker at concurrency 1, each retry holds the queue for another two
 * minutes plus backoff, stalling every other repo's scan behind a scan that has
 * already decided its own fate. Discarding stops the retries; the row is already
 * marked 'failed' with its credit refunded, and the customer can rescan.
 *
 * Parse failures are deliberately NOT in here: those have shown up as transient
 * (a truncated or malformed response), so they keep their retries.
 */
function isTerminalScanError(err: unknown): boolean {
  return err instanceof AITimeoutError;
}

export default async function scanWorkerProcessor(
  job: Bull.Job<ScanJobData>,
): Promise<void> {
  // Bull increments attemptsMade only once the processor has thrown, so during a
  // run it counts the attempts *before* this one: 0 on the first. This is
  // therefore the last attempt when attemptsMade + 1 has reached the cap. A
  // discarded job is also final regardless of the count — Job#moveToFailed
  // short-circuits its retry gate on _discarded.
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
      // discard() is synchronous and returns nothing — it only sets the flag
      // that Job#moveToFailed checks before scheduling a retry. The throw below
      // is still what moves the job to 'failed'.
      job.discard();
    }
    throw err;
  }
}
