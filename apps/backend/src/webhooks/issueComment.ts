import {getDiff} from "../lib/github";
import {
  saveScan,
  getOrgByInstallationId,
  tryClaimScan,
  scanExistsForCommit,
} from "../db/queries";
import {parseDiffStats, truncateDiff} from "../lib/differ";
import {scanQueue} from "../lib/queue";
import {processScanJob} from "../lib/workers/scanWorker";
import {App} from "@octokit/app";

const SCAN_LIMITS: Record<string, number> = {free: 10, starter: 50};

function getApp(): App {
  const appId = process.env.GITHUB_APP_ID;
  const encodedKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !encodedKey)
    throw new Error("Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY");
  const privateKey = Buffer.from(encodedKey, "base64").toString("utf8");
  return new App({appId, privateKey});
}

async function getOctokit(installationId: number) {
  return getApp().getInstallationOctokit(installationId);
}

export async function handleIssueComment(
  payload: Record<string, unknown>,
): Promise<void> {
  if ((payload.action as string) !== "created") return;

  const comment = payload.comment as Record<string, unknown>;
  const issue = payload.issue as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const installation = payload.installation as Record<string, unknown> | undefined;

  // Only handle PR comments — plain issues have no pull_request field
  if (!issue.pull_request) return;

  const body = (comment.body as string | undefined)?.trim() ?? "";
  if (body.toLowerCase() !== "/gitsentry rescan") return;

  // Only allow collaborators / owners / org members to trigger rescans
  const association = comment.author_association as string;
  if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(association)) return;

  const installationId = installation?.id as number | undefined;
  if (!installationId) return;

  const prNumber = issue.number as number;
  const repoFullName = repo.full_name as string;
  const sender = (payload.sender as Record<string, unknown>).login as string;
  const octokit = await getOctokit(installationId);
  const [owner, repoName] = repoFullName.split("/");

  // Fetch PR to get current HEAD sha + metadata
  const {data: pr} = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {owner, repo: repoName, pull_number: prNumber},
  );

  const commitSha = pr.head.sha;
  const prRef = pr.head.ref;
  const prAuthor = pr.user?.login ?? null;
  const isPrivate = (repo.private as boolean) ?? false;

  const org = await getOrgByInstallationId(installationId);
  const plan = org?.plan ?? "free";
  const isPro = plan === "pro";

  // Quota check for non-pro plans
  if (!isPro) {
    const scanLimit = SCAN_LIMITS[plan] ?? SCAN_LIMITS.free;
    const claimed = org ? await tryClaimScan(org.id, scanLimit) : false;

    if (!claimed) {
      await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo: repoName,
          issue_number: prNumber,
          body: [
            `> /gitsentry rescan`,
            "",
            `@${sender} — re-scan not started. You've reached your monthly scan limit on the **${plan}** plan.`,
            "",
            `[Upgrade to Pro](${process.env.PRODUCT_URL}/dashboard/billing) for unlimited scans.`,
            "",
            `_Powered by [Gitsentry.dev](${process.env.PRODUCT_URL})_`,
          ].join("\n"),
        },
      );
      return;
    }
  }

  // Post acknowledgment immediately so the user knows something is happening
  const currentMonth = new Date().toISOString().slice(0, 7);
  const orgData = org as (typeof org & {scan_count_month?: number | null; scan_month?: string | null}) | null;
  const scansUsed =
    orgData?.scan_month === currentMonth ? (orgData?.scan_count_month ?? 0) : 0;
  const scanLimit = SCAN_LIMITS[plan] ?? SCAN_LIMITS.free;
  const remaining = isPro ? null : Math.max(0, scanLimit - scansUsed);

  const quotaLine = remaining !== null
    ? `_This scan uses 1 of your ${remaining} remaining scans this month._`
    : "";

  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: [
        `> /gitsentry rescan`,
        "",
        `🔄 **Gitsentry.dev** — re-scan triggered by @${sender}`,
        "",
        `Scanning \`${commitSha.slice(0, 7)}\`… results will update the existing security comment. This takes 30–60 seconds.`,
        quotaLine,
        "",
        `_Powered by [Gitsentry.dev](${process.env.PRODUCT_URL})_`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  );

  const diff = await getDiff(repoFullName, prNumber, installationId);
  if (!diff || diff.length < 10) return;

  const {filesChanged, linesAdded} = parseDiffStats(diff);

  const scan = await saveScan({
    repoFullName,
    repoGithubId: repo.id as number,
    repoOwner: {
      githubId: (repo.owner as Record<string, unknown>).id as number,
      login: (repo.owner as Record<string, unknown>).login as string,
      avatarUrl: (repo.owner as Record<string, unknown>).avatar_url as string | null,
    },
    installationId,
    isPrivate,
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
    repoFullName,
    diff: truncateDiff(diff),
    context: {
      repo: repoFullName,
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
      console.error(`[issue_comment] inline scan failed for ${repoFullName}#${prNumber}:`, err.message),
    );
  }
}
