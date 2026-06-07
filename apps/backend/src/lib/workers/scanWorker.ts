import type Bull from "bull";
import { analyzeCode, discoverSecurityContext } from "../ai";
import {
  postPRReview,
  postCommitComment,
  postCheckRun,
  postUpgradeComment,
  setupBranchProtection,
  fetchRepoAuthFiles,
} from "../github";
import {
  saveFindings,
  updateScanStatus,
  getOrgByRepoId,
  tryClaimScan,
  getPreviousPRCommentId,
  updateScanCommentId,
  getRepoSecurityContext,
  saveRepoSecurityContext,
} from "../../db/queries";
import { notifyIfNeeded } from "../notifier";
import type { ScanJobData } from "../../../../../packages/scanner-contract/types";

const SCAN_LIMITS: Record<string, number> = {free: 10, starter: 50, pro: 500};

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

    // Claim a scan slot for all plans (including Pro, which is capped at 500/month).
    // Skip when the caller already claimed atomically (rescan endpoint, issue_comment
    // webhook) to prevent double-counting.
    if (org && !quotaAlreadyClaimed) {
      const claimed = await tryClaimScan(org.id, scanLimit, org.plan ?? "free", org.scan_month ?? null);
      if (!claimed) {
        console.log(
          `[worker] Scan ${scanId} skipped: ${org.plan ?? "free"} limit (${scanLimit}/month) reached`,
        );
        await updateScanStatus(scanId, [], 0, "failed");
        postUpgradeComment(repoFullName, {prNumber, commitSha}, installationId).catch(
          (err: Error) => console.error("[worker] upgrade comment failed:", err.message),
        );
        return;
      }
    }

    // Fetch or discover the per-repo security context so the AI understands
    // this codebase's auth and rate-limit patterns before scanning.
    let repoSecurityContext = await getRepoSecurityContext(repoId);
    if (!repoSecurityContext) {
      try {
        const authFiles = await fetchRepoAuthFiles(repoFullName, branch, installationId);
        if (authFiles.length > 0) {
          repoSecurityContext = await discoverSecurityContext(authFiles, repoFullName);
          if (repoSecurityContext) {
            saveRepoSecurityContext(repoId, repoSecurityContext).catch((err: Error) =>
              console.error("[worker] saveRepoSecurityContext failed:", err.message),
            );
          }
        }
      } catch (err) {
        console.warn("[worker] security context discovery failed — scanning without it:", (err as Error).message);
      }
    }

    const { issues, summary, tokens_in, tokens_out, model_name } = await analyzeCode(diff, {
      ...context,
      repoSecurityContext,
    });

    const [findings, previousComment] = await Promise.all([
      issues.length > 0
        ? saveFindings(scanId, issues)
        : Promise.resolve([] as Awaited<ReturnType<typeof saveFindings>>),
      prNumber != null ? getPreviousPRCommentId(repoId, prNumber) : Promise.resolve(null),
    ]);

    if (prNumber != null) {
      const existingCommentId = previousComment?.commentId ?? null;

      // Skip only when this scan and the prior comment are both already clean.
      const skipCleanUpdate = issues.length === 0 && !!existingCommentId && !previousComment?.hadFindings;
      if (!skipCleanUpdate) {
        const commentId = await withTimeout(
          postPRReview(repoFullName, prNumber, findings, summary, scanId, installationId, existingCommentId),
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
      postCheckRun(repoFullName, commitSha, findings, installationId).catch((err: Error) =>
        console.error("[worker] check run failed:", err.message),
      );
    }

    await updateScanStatus(scanId, issues, Date.now() - startedAt, "complete", {
      tokensIn: tokens_in ?? 0,
      tokensOut: tokens_out ?? 0,
      modelName: model_name,
    });
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
