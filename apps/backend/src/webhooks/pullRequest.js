const { getDiff } = require("../lib/github");
const { saveScan } = require("../db/queries");
const { parseDiffStats, truncateDiff } = require("../lib/differ");
const { scanQueue } = require("../lib/queue");
const { processScanJob } = require("../lib/workers/scanWorker");

async function handlePR(payload) {
  const { action, pull_request: pr, repository: repo, installation } = payload;

  if (!["opened", "synchronize"].includes(action)) return;

  const installationId = installation?.id;
  if (!installationId) {
    console.warn("[PR] Missing installation.id — is this a GitHub App webhook?");
    return;
  }

  const diff = await getDiff(repo.full_name, pr.number, installationId);
  if (!diff || diff.length < 10) return;

  const { filesChanged, linesAdded } = parseDiffStats(diff);

  const scan = await saveScan({
    repoFullName: repo.full_name,
    repoGithubId: repo.id,
    repoOwner: { githubId: repo.owner.id, login: repo.owner.login, avatarUrl: repo.owner.avatar_url },
    installationId,
    triggerType: "pull_request",
    triggerRef: String(pr.number),
    commitSha: pr.head.sha,
    author: pr.user.login,
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
      branch: pr.head.ref,
      triggerType: "pull_request",
      author: pr.user.login,
    },
    installationId,
    prNumber: pr.number,
    commitSha: pr.head.sha,
    branch: pr.head.ref,
    triggerType: "pull_request",
  };

  if (scanQueue) {
    await scanQueue.add(jobData);
  } else {
    processScanJob(jobData).catch((err) =>
      console.error(`[PR] Inline scan failed for ${repo.full_name}#${pr.number}:`, err.message)
    );
  }
}

module.exports = { handlePR };
