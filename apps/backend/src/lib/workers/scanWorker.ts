import type Bull from "bull";
import { analyzeCode } from "../ai";
import {
  postPRReview,
  postCommitComment,
  postCheckRun,
  postUpgradeComment,
  setupBranchProtection,
} from "../github";
import { resolveSecurityContext } from "../securityContext";
import {
  saveFindings,
  updateScanStatus,
  getOrgByRepoId,
  tryClaimScan,
  getPreviousPRCommentId,
  updateScanCommentId,
  recordAiUsage,
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
    // When org is null (public repo with no DB record yet) treat as anonymous free tier.
    if (!quotaAlreadyClaimed) {
      if (!org) {
        // No org record means we cannot enforce per-org quota — fail closed to prevent
        // unlimited free scans on public repos that never completed installation setup.
        console.log(`[worker] Scan ${scanId} skipped: no org record (installation incomplete)`);
        await updateScanStatus(scanId, [], 0, "failed");
        return;
      }
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
          postPRReview(repoFullName, prNumber, findings, summary, scanId, installationId, existingCommentId, coverage),
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
