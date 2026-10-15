import express, {Request, Response} from "express";
import {requireInternalKey} from "./internalAuth";
import {getDiff, getInstallationOctokit} from "../lib/github";
import {
  saveScan,
  getOrgByRepoId,
  verifyRepoInstallation,
  getRepoRow,
  tryClaimScan,
} from "../db/queries";
import {parseDiffStats, truncateDiff} from "../lib/differ";
import {dispatchScan} from "../lib/queue";

const router = express.Router();

const SCAN_LIMITS: Record<string, number> = {free: 10, starter: 50, pro: 500};

const verifyInternalKey = requireInternalKey("rescan");

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

    // Claim the slot atomically before any GitHub work; quotaAlreadyClaimed on
    // the job tells the worker to skip its own claim.
    const claimed = org
      ? await tryClaimScan(
          org.id, scanLimit, plan, org.scan_month ?? null,
          !!org.paddle_subscription_id,
        )
      : false;
    if (!claimed) {
      res.status(402).json({
        error: `Monthly scan limit reached on the ${plan} plan (${scanLimit}/month).`,
        remaining: 0,
        upgradeUrl: `${process.env.PRODUCT_URL}/dashboard/billing`,
      });
      return;
    }

    // Advisory only. On free, a stale scan_month means the RPC just reset the
    // month, so treat it as 0 used; paid scan_month is Paddle-controlled.
    const currentCalMonth = new Date().toISOString().slice(0, 7);
    const scansUsedBefore =
      plan === "free"
        ? (org?.scan_month === currentCalMonth ? (org?.scan_count_month ?? 0) : 0)
        : (org?.scan_count_month ?? 0);
    const remaining = Math.max(0, scanLimit - scansUsedBefore - 1);

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
      quotaAlreadyClaimed: true,
    };

    dispatchScan(jobData, `rescan ${repoRow.full_name}#${prNumber}`);
    res.json({scanId: scan.id, remaining, plan});
  },
);

export default router;
