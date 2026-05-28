import { getDiff } from "../lib/github";
import { saveScan, getOrgByInstallationId } from "../db/queries";
import { parseDiffStats, truncateDiff } from "../lib/differ";
import { dispatchScan } from "../lib/queue";

/**
 * Handles check_run: rerequested — fired when a Pro user clicks "Re-run"
 * on the "Gitsentry Security Scan" check in a GitHub PR.
 *
 * Free and Starter users never receive check runs, so this event only ever
 * fires for Pro organisations.
 */
export async function handleCheckRun(payload: Record<string, unknown>): Promise<void> {
  const action = payload.action as string;
  const checkRun = payload.check_run as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const installation = payload.installation as Record<string, unknown> | undefined;
  const sender = payload.sender as Record<string, unknown> | undefined;

  if (action !== "rerequested") return;
  if (checkRun.name !== "Gitsentry Security Scan") return;

  const installationId = installation?.id as number | undefined;
  if (!installationId) return;

  const org = await getOrgByInstallationId(installationId);
  if (!org || org.plan !== "pro") return;

  const pullRequests = checkRun.pull_requests as Array<Record<string, unknown>> | undefined;
  const pr = pullRequests?.[0];
  if (!pr) {
    console.log(`[check_run] Rerequested but no associated PR for ${repo.full_name}`);
    return;
  }

  const headSha = checkRun.head_sha as string;
  const prNumber = pr.number as number;
  const prHead = pr.head as Record<string, unknown> | undefined;
  const branch = (prHead?.ref as string | undefined) ?? "";
  const repoOwner = repo.owner as Record<string, unknown>;

  const diff = await getDiff(repo.full_name as string, prNumber, installationId);
  if (!diff || diff.length < 10) return;

  const { filesChanged, linesAdded } = parseDiffStats(diff);

  const scan = await saveScan({
    repoFullName: repo.full_name as string,
    repoGithubId: repo.id as number,
    repoOwner: {
      githubId: repoOwner.id as number,
      login: repoOwner.login as string,
      avatarUrl: repoOwner.avatar_url as string | null,
    },
    installationId,
    isPrivate: (repo.private as boolean) ?? false,
    triggerType: "pull_request",
    triggerRef: String(prNumber),
    commitSha: headSha,
    author: (sender?.login as string | undefined) ?? "unknown",
    filesChanged,
    linesAdded,
  });

  const jobData = {
    scanId: scan.id,
    repoId: scan.repo_id,
    repoFullName: repo.full_name as string,
    diff: truncateDiff(diff),
    context: {
      repo: repo.full_name as string,
      branch,
      triggerType: "pull_request" as const,
      author: (sender?.login as string | undefined) ?? "unknown",
    },
    installationId,
    prNumber,
    commitSha: headSha,
    branch,
    triggerType: "pull_request",
  };

  console.log(
    `[check_run] Re-run requested by ${sender?.login} for ${repo.full_name}#${prNumber}`,
  );

  dispatchScan(jobData, `check_run ${repo.full_name}#${prNumber}`);
}
