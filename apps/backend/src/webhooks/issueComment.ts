import {getDiff, getInstallationOctokit} from "../lib/github";
import {
  saveScan,
  getOrgByInstallationId,
  tryClaimScan,
} from "../db/queries";
import {parseDiffStats, truncateDiff} from "../lib/differ";
import {dispatchScan} from "../lib/queue";

const SCAN_LIMITS: Record<string, number> = {free: 10, starter: 50, pro: 500};

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
  const normalizedBody = body.toLowerCase();
  if (normalizedBody !== "/gitsentry rescan" && normalizedBody !== "/gitsentry scan") return;

  // Only allow collaborators / owners / org members to trigger rescans
  const association = comment.author_association as string;
  if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(association)) return;

  const installationId = installation?.id as number | undefined;
  if (!installationId) return;

  const prNumber = issue.number as number;
  const repoFullName = repo.full_name as string;
  const sender = (payload.sender as Record<string, unknown>).login as string;
  const octokit = await getInstallationOctokit(installationId);
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

  // getOrgByInstallationId now returns OrgWithUsage including subscription_status
  const org = await getOrgByInstallationId(installationId);
  const plan = org?.plan ?? "free";

  // Quota check — all plans including Pro (capped at 500/month)
  const scanLimit = SCAN_LIMITS[plan] ?? SCAN_LIMITS.free;
  const claimed = org ? await tryClaimScan(org.id, scanLimit, plan, org.scan_month ?? null) : false;

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
          `@${sender} — re-scan not started. You've reached your monthly scan limit (${scanLimit}/month) on the **${plan}** plan.`,
          "",
          plan === "pro"
            ? `Contact support if you need a higher limit.`
            : `[Upgrade to Pro](${process.env.PRODUCT_URL}/dashboard/billing) for 500 scans/month.`,
          "",
          `_Powered by [Gitsentry.dev](${process.env.PRODUCT_URL})_`,
        ].join("\n"),
      },
    );
    return;
  }

  // Post acknowledgment immediately so the user knows something is happening.
  const currentCalMonth = new Date().toISOString().slice(0, 7);
  const scansUsed =
    plan === "free"
      ? (org?.scan_month === currentCalMonth ? (org?.scan_count_month ?? 0) : 0)
      : (org?.scan_count_month ?? 0);
  const remaining = Math.max(0, scanLimit - scansUsed - 1);

  const quotaLine = `_This scan uses 1 of your ${remaining} remaining scans this month._`;

  const isScanCommand = normalizedBody === "/gitsentry scan";
  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: [
        `> ${body}`,
        "",
        `🔄 **Gitsentry.dev** — ${isScanCommand ? "scan" : "re-scan"} triggered by @${sender}`,
        "",
        `Scanning \`${commitSha.slice(0, 7)}\`… results will appear as a security comment on this PR. This takes 30–60 seconds.`,
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
    quotaAlreadyClaimed: true,
  };

  dispatchScan(jobData, `issue_comment ${repoFullName}#${prNumber}`);
}
