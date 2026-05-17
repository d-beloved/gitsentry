const { getPushDiff } = require("../lib/github");
const { saveScan, getOrgByInstallationId } = require("../db/queries");
const { parseDiffStats, truncateDiff } = require("../lib/differ");
const { scanQueue } = require("../lib/queue");
const { processScanJob } = require("../lib/workers/scanWorker");

const {MAIN_BRANCHES} = require("../../../../packages/scanner-contract/constants");

async function handlePush(payload) {
  const { ref, commits, repository: repo, pusher, installation } = payload;

  if (!ref.startsWith("refs/heads/") || !commits?.length) return;

  const installationId = installation?.id;
  if (!installationId) {
    console.warn("[push] Missing installation.id — is this a GitHub App webhook?");
    return;
  }

  // Private repos require a paid plan — skip silently on free
  if (repo.private) {
    const org = await getOrgByInstallationId(installationId);
    if (!org || org.plan === "free") {
      console.log(`[push] Skipping private repo ${repo.full_name} — free plan`);
      return;
    }
  }

  const branch = ref.replace("refs/heads/", "");
  const isMain = MAIN_BRANCHES.includes(branch);
  const latestCommit = commits[commits.length - 1];

  const diff = await getPushDiff(repo.full_name, latestCommit.id, installationId);
  if (!diff || diff.length < 10) return;

  const { filesChanged, linesAdded } = parseDiffStats(diff);
  const triggerType = isMain ? "push_main" : "push_branch";

  const scan = await saveScan({
    repoFullName: repo.full_name,
    repoGithubId: repo.id,
    repoOwner: { githubId: repo.owner.id, login: repo.owner.login, avatarUrl: repo.owner.avatar_url },
    installationId,
    isPrivate: repo.private ?? false,
    triggerType,
    triggerRef: branch,
    commitSha: latestCommit.id,
    author: pusher.name,
    filesChanged,
    linesAdded,
  });

  const jobData = {
    scanId: scan.id,
    repoId: scan.repo_id,
    repoFullName: repo.full_name,
    diff: truncateDiff(diff),
    context: {
      repo: repo.full_name,
      branch,
      triggerType,
      author: pusher.name,
    },
    installationId,
    prNumber: null,
    commitSha: latestCommit.id,
    branch,
    triggerType,
  };

  if (scanQueue) {
    await scanQueue.add(jobData);
  } else {
    processScanJob(jobData).catch((err) =>
      console.error(`[push] Inline scan failed for ${repo.full_name} ${branch}:`, err.message)
    );
  }
}

module.exports = { handlePush };
