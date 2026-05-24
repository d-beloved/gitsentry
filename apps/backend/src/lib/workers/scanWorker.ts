import type Bull from "bull";
import { analyzeCode } from "../ai";
import {
  postPRReview,
  postCommitComment,
  postCheckRun,
  postUpgradeComment,
} from "../github";
import {
  saveFindings,
  updateScanStatus,
  getOrgByRepoId,
  incrementScanCount,
} from "../../db/queries";
import { notifyIfNeeded } from "../notifier";
import type { ScanJobData } from "../../../../../packages/scanner-contract/types";

const SCAN_LIMITS: Record<string, number> = { free: 10, starter: 50 };

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
  } = data;
  const startedAt = Date.now();

  try {
    const org = await getOrgByRepoId(repoId);
    const isPro = org?.plan === "pro";
    const scanLimit = SCAN_LIMITS[org?.plan ?? "free"] ?? SCAN_LIMITS.free;

    if (org && !isPro) {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const scansThisMonth =
        org.scan_month === currentMonth ? (org.scan_count_month || 0) : 0;
      if (scansThisMonth >= scanLimit) {
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
        await postPRReview(repoFullName, prNumber, findings, summary, scanId, installationId);
      } else if (commitSha) {
        await postCommitComment(
          repoFullName,
          commitSha,
          findings,
          summary,
          scanId,
          installationId,
        );
      }

      await notifyIfNeeded(repoId, repoFullName, findings, triggerType, branch, scanId);
    }

    // Check Run — Pro plan only
    if (prNumber != null && commitSha && isPro) {
      postCheckRun(repoFullName, commitSha, findings, installationId).catch((err: Error) =>
        console.error("[worker] check run failed:", err.message),
      );
    }

    await updateScanStatus(scanId, issues, Date.now() - startedAt);

    if (org) {
      incrementScanCount(org.id).catch((err: Error) =>
        console.error("[worker] scan count increment failed:", err.message),
      );
    }
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
