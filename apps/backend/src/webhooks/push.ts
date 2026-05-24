import { getPushDiff } from "../lib/github";
import { saveScan, getOrgByInstallationId } from "../db/queries";
import { parseDiffStats, truncateDiff } from "../lib/differ";
import { scanQueue } from "../lib/queue";
import { processScanJob } from "../lib/workers/scanWorker";

export async function handlePush(payload: Record<string, unknown>): Promise<void> {
  const ref = payload.ref as string;
  const commits = payload.commits as unknown[] | undefined;
  const repo = payload.repository as Record<string, unknown>;
  const pusher = payload.pusher as Record<string, unknown>;
  const installation = payload.installation as Record<string, unknown> | undefined;

  if (!ref.startsWith("refs/heads/") || !commits?.length) return;

  const defaultBranch = (repo.default_branch as string | undefined) ?? "main";
  const branch = ref.replace("refs/heads/", "");
  if (branch !== defaultBranch) return;

  const installationId = installation?.id as number | undefined;
  if (!installationId) {
    console.warn("[push] Missing installation.id — is this a GitHub App webhook?");
    return;
  }

  if (repo.private) {
    const org = await getOrgByInstallationId(installationId);
    if (!org || org.plan === "free") {
      console.log(`[push] Skipping private repo ${repo.full_name} — free plan`);
      return;
    }
  }

  const latestCommit = commits[commits.length - 1] as Record<string, unknown>;
  const repoOwner = repo.owner as Record<string, unknown>;

  const diff = await getPushDiff(
    repo.full_name as string,
    latestCommit.id as string,
    installationId,
  );
  if (!diff || diff.length < 10) return;

  const { filesChanged, linesAdded } = parseDiffStats(diff);
  const triggerType = "push_main";

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
    triggerType,
    triggerRef: branch,
    commitSha: latestCommit.id as string,
    author: pusher.name as string,
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
      triggerType: "push_main" as const,
      author: pusher.name as string,
    },
    installationId,
    prNumber: null,
    commitSha: latestCommit.id as string,
    branch,
    triggerType,
  };

  if (scanQueue) {
    await scanQueue.add(jobData);
  } else {
    processScanJob(jobData).catch((err: Error) =>
      console.error(
        `[push] Inline scan failed for ${repo.full_name} ${branch}:`,
        err.message,
      ),
    );
  }
}
