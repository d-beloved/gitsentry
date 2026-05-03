const { analyzeCode } = require("../lib/ai");
const { getDiff, postPRReview } = require("../lib/github");
const { saveScan, saveFindings, updateScanStatus } = require("../db/queries");
const { notifyIfNeeded } = require("../lib/notifier");
const { parseDiffStats } = require("../lib/differ");

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

  const context = {
    repo: repo.full_name,
    branch: pr.head.ref,
    triggerType: "pull_request",
    author: pr.user.login,
  };

  const startedAt = Date.now();

  const scan = await saveScan({
    repoFullName: repo.full_name,
    repoGithubId: repo.id,
    triggerType: "pull_request",
    triggerRef: String(pr.number),
    commitSha: pr.head.sha,
    author: pr.user.login,
    filesChanged,
    linesAdded,
  });

  try {
    const { issues, summary } = await analyzeCode(diff, context);

    if (issues.length > 0) {
      await saveFindings(scan.id, issues);
      await postPRReview(repo.full_name, pr.number, issues, summary, scan.id, installationId);
      await notifyIfNeeded(repo.full_name, issues, "pull_request", pr.head.ref);
    }

    await updateScanStatus(scan.id, issues, Date.now() - startedAt);
  } catch (err) {
    console.error(`[PR] Analysis failed for ${repo.full_name}#${pr.number}:`, err);
    await updateScanStatus(scan.id, [], 0, "failed");
  }
}

module.exports = { handlePR };
