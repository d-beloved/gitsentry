import express, {Request, Response, NextFunction} from "express";
import {getDiff, getInstallationOctokit} from "../lib/github";
import {
  saveScan,
  getOrgByRepoId,
  verifyRepoInstallation,
  getRepoRow,
} from "../db/queries";
import {parseDiffStats, truncateDiff} from "../lib/differ";
import {scanQueue} from "../lib/queue";
import {processScanJob} from "../lib/workers/scanWorker";

const router = express.Router();

const SCAN_LIMITS: Record<string, number> = {free: 10, starter: 50};

function verifyInternalKey(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) {
    console.error("[rescan] INTERNAL_API_KEY is not configured — rejecting request");
    res.status(503).json({error: "Endpoint not available"});
    return;
  }
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${key}`) {
    res.status(401).json({error: "Unauthorized"});
    return;
  }
  next();
}

router.post(
  "/",
  verifyInternalKey,
  async (req: Request, res: Response): Promise<void> => {
    const {repoId, prNumber, installationId} = req.body as {
      repoId?: string;
      prNumber?: number;
      installationId?: number;
    };

    if (!repoId || prNumber == null || !installationId) {
      res.status(400).json({error: "repoId, prNumber, and installationId are required"});
      return;
    }

    const repoOwned = await verifyRepoInstallation(repoId, installationId);
    if (!repoOwned) {
      res.status(403).json({error: "Forbidden"});
      return;
    }

    const [org, repoRow] = await Promise.all([
      getOrgByRepoId(repoId),
      getRepoRow(repoId),
    ]);

    if (!repoRow) {
      res.status(404).json({error: "Repo not found"});
      return;
    }

    const plan = org?.plan ?? "free";
    const isPro =
      plan === "pro" &&
      (org?.subscription_status === "active" || org?.subscription_status == null);
    const scanLimit = SCAN_LIMITS[plan] ?? SCAN_LIMITS.free;

    // Compute remaining for display (worker handles the actual quota claim)
    const currentMonth = new Date().toISOString().slice(0, 7);
    const scansUsedBefore =
      org?.scan_month === currentMonth ? (org?.scan_count_month ?? 0) : 0;
    const remaining = isPro ? null : Math.max(0, scanLimit - scansUsedBefore);

    if (!isPro && scansUsedBefore >= scanLimit) {
      res.status(402).json({
        error: `Monthly scan limit reached on the ${plan} plan.`,
        remaining: 0,
        upgradeUrl: `${process.env.PRODUCT_URL}/dashboard/billing`,
      });
      return;
    }

    const octokit = await getInstallationOctokit(installationId);
    const [owner, repoName] = repoRow.full_name.split("/");

    const {data: pr} = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {owner, repo: repoName, pull_number: prNumber},
    );

    const commitSha = pr.head.sha;
    const prRef = pr.head.ref;
    const prAuthor = pr.user?.login ?? null;

    const diff = await getDiff(repoRow.full_name, prNumber, installationId);
    if (!diff || diff.length < 10) {
      res.status(422).json({error: "No diff found for this PR."});
      return;
    }

    const {filesChanged, linesAdded} = parseDiffStats(diff);

    const scan = await saveScan({
      repoFullName: repoRow.full_name,
      repoGithubId: repoRow.github_id,
      repoOwner: null,
      installationId,
      isPrivate: repoRow.is_private,
      triggerType: "pull_request",
      triggerRef: String(prNumber),
      commitSha,
      author: prAuthor,
      filesChanged,
      linesAdded,
    });

    const jobData = {
      scanId: scan.id,
      repoId: scan.repo_id,
      repoFullName: repoRow.full_name,
      diff: truncateDiff(diff),
      context: {
        repo: repoRow.full_name,
        branch: prRef,
        triggerType: "pull_request" as const,
        author: prAuthor,
      },
      installationId,
      prNumber,
      commitSha,
      branch: prRef,
      triggerType: "pull_request",
    };

    if (scanQueue) {
      await scanQueue.add(jobData);
    } else {
      processScanJob(jobData).catch((err: Error) =>
        console.error(`[rescan] inline scan failed for ${repoRow.full_name}#${prNumber}:`, err.message),
      );
    }

    res.json({scanId: scan.id, remaining, plan});
  },
);

export default router;
