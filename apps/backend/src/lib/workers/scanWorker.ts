import type Bull from "bull";
import { analyzeCode } from "../ai";
import {
  postPRReview,
  postCommitComment,
  postCheckRun,
  postUpgradeComment,
  setupBranchProtection,
} from "../github";
import {
  saveFindings,
  updateScanStatus,
  getOrgByRepoId,
  tryClaimScan,
  getPreviousPRCommentId,
  updateScanCommentId,
} from "../../db/queries";
import { notifyIfNeeded } from "../notifier";
import type { ScanJobData } from "../../../../../packages/scanner-contract/types";

const SCAN_LIMITS: Record<string, number> = { free: 10, starter: 50 };

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[worker] ${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

export async function processScanJob(data: ScanJobData): Promise<void> {
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

  try {
    const org = await getOrgByRepoId(repoId);
    const isPro =
      org?.plan === "pro" &&
      (org?.subscription_status === "active" || org?.subscription_status == null);
    const scanLimit = SCAN_LIMITS[org?.plan ?? "free"] ?? SCAN_LIMITS.free;

    // Skip the quota claim when the caller already claimed it atomically (rescan
    // endpoint, issue_comment webhook). Only claim here for push/PR webhook scans
    // where no prior claim was made.
    if (org && !isPro && !quotaAlreadyClaimed) {
      const claimed = await tryClaimScan(org.id, scanLimit);
      if (!claimed) {
        console.log(
          `[worker] Scan ${scanId} skipped: ${org.plan ?? "free"} limit (${scanLimit}/month) reached`,
        );
        await updateScanStatus(scanId, [], 0, "failed");
        postUpgradeComment(repoFullName, { prNumber, commitSha }, installationId).catch(
          (err: Error) => console.error("[worker] upgrade comment failed:", err.message),
        );
        return;
      }
    }

    const { issues, summary } = await analyzeCode(diff, context);

    let findings: Awaited<ReturnType<typeof saveFindings>> = [];
    if (issues.length > 0) {
      findings = await saveFindings(scanId, issues);

      if (prNumber != null) {
        const existingCommentId = await getPreviousPRCommentId(repoId, prNumber);
        const commentId = await withTimeout(
          postPRReview(repoFullName, prNumber, findings, summary, scanId, installationId, existingCommentId),
          30_000,
          "postPRReview",
        );
        updateScanCommentId(scanId, commentId).catch((err: Error) =>
          console.error("[worker] updateScanCommentId failed:", err.message),
        );
      } else if (commitSha) {
        await withTimeout(
          postCommitComment(repoFullName, commitSha, findings, summary, scanId, installationId),
          30_000,
          "postCommitComment",
        );
      }

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
      postCheckRun(repoFullName, commitSha, findings, installationId).catch((err: Error) =>
        console.error("[worker] check run failed:", err.message),
      );
    }

    await updateScanStatus(scanId, issues, Date.now() - startedAt);
  } catch (err) {
    console.error(`[worker] Scan ${scanId} failed:`, (err as Error).message);
    await updateScanStatus(scanId, [], 0, "failed").catch(() => {});
    throw err;
  }
}

export default function scanWorkerProcessor(
  job: Bull.Job<ScanJobData>,
): Promise<void> {
  return processScanJob(job.data);
}
