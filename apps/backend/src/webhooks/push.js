const { analyzeCode } = require("../lib/ai");
const { getPushDiff, postCommitComment } = require("../lib/github");
const { saveScan, saveFindings, updateScanStatus } = require("../db/queries");
const { notifyIfNeeded } = require("../lib/notifier");
const { parseDiffStats } = require("../lib/differ");

const MAIN_BRANCHES = ["main", "master"];

async function handlePush(payload) {
  const { ref, commits, repository: repo, pusher, installation } = payload;

  // Skip tag pushes and empty commits
  if (!ref.startsWith("refs/heads/") || !commits?.length) return;

  const installationId = installation?.id;
  if (!installationId) {
    console.warn("[push] Missing installation.id — is this a GitHub App webhook?");
    return;
  }

  const branch = ref.replace("refs/heads/", "");
  const isMain = MAIN_BRANCHES.includes(branch);
  const latestCommit = commits[commits.length - 1];

  const diff = await getPushDiff(repo.full_name, latestCommit.id, installationId);
  if (!diff || diff.length < 10) return;

  const { filesChanged, linesAdded } = parseDiffStats(diff);

  const context = {
    repo: repo.full_name,
    branch,
    triggerType: isMain ? "push_main" : "push_branch",
    author: pusher.name,
  };

  const startedAt = Date.now();

  const scan = await saveScan({
    repoFullName: repo.full_name,
    repoGithubId: repo.id,
    triggerType: context.triggerType,
    triggerRef: branch,
    commitSha: latestCommit.id,
    author: pusher.name,
    filesChanged,
    linesAdded,
  });

  try {
    const { issues, summary } = await analyzeCode(diff, context);

    if (issues.length > 0) {
      const findings = await saveFindings(scan.id, issues);
      await postCommitComment(
        repo.full_name,
        latestCommit.id,
        findings,
        summary,
        scan.id,
        installationId
      );
      await notifyIfNeeded(repo.full_name, findings, context.triggerType, branch);
    }

    await updateScanStatus(scan.id, issues, Date.now() - startedAt);
  } catch (err) {
    console.error(`[push] Analysis failed for ${repo.full_name} ${branch}:`, err);
    await updateScanStatus(scan.id, [], 0, "failed");
  }
}

module.exports = { handlePush };
