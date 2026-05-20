const { getDiff } = require("../lib/github");
const { saveScan, getOrgByInstallationId } = require("../db/queries");
const { parseDiffStats, truncateDiff } = require("../lib/differ");
const { scanQueue } = require("../lib/queue");
const { processScanJob } = require("../lib/workers/scanWorker");

/**
 * Handles check_run: rerequested — fired when a Pro user clicks "Re-run"
 * on the "Gitsentry Security Scan" check in a GitHub PR.
 *
 * This is the primary manual re-scan mechanism for Pro users. It requires no
 * UI on our side — GitHub provides the Re-run button natively on any check run.
 *
 * Free and Starter users never receive check runs, so this event only ever
 * fires for Pro organisations.
 */
async function handleCheckRun(payload) {
  const { action, check_run, repository: repo, installation, sender } = payload;

  if (action !== "rerequested") return;
  if (check_run.name !== "Gitsentry Security Scan") return;

  const installationId = installation?.id;
  if (!installationId) return;

  // Verify Pro — only Pro orgs have check runs to re-run
  const org = await getOrgByInstallationId(installationId);
  if (!org || org.plan !== "pro") return;

  // check_run.pull_requests contains the PRs this check run is associated with
  const pr = check_run.pull_requests?.[0];
  if (!pr) {
    console.log(`[check_run] Rerequested but no associated PR for ${repo.full_name}`);
    return;
  }

  const headSha = check_run.head_sha;
  const prNumber = pr.number;
  const branch = pr.head?.ref ?? "";

  const diff = await getDiff(repo.full_name, prNumber, installationId);
  if (!diff || diff.length < 10) return;

  const { filesChanged, linesAdded } = parseDiffStats(diff);

  const scan = await saveScan({
    repoFullName: repo.full_name,
    repoGithubId: repo.id,
    repoOwner: { githubId: repo.owner.id, login: repo.owner.login, avatarUrl: repo.owner.avatar_url },
    installationId,
    isPrivate: repo.private ?? false,
    triggerType: "pull_request",
    triggerRef: String(prNumber),
    commitSha: headSha,
    author: sender?.login ?? "unknown",
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
      triggerType: "pull_request",
      author: sender?.login ?? "unknown",
    },
    installationId,
    prNumber,
    commitSha: headSha,
    branch,
    triggerType: "pull_request",
  };

  console.log(`[check_run] Re-run requested by ${sender?.login} for ${repo.full_name}#${prNumber}`);

  if (scanQueue) {
    await scanQueue.add(jobData);
  } else {
    processScanJob(jobData).catch((err) =>
      console.error(`[check_run] Inline scan failed for ${repo.full_name}#${prNumber}:`, err.message)
    );
  }
}

module.exports = { handleCheckRun };
