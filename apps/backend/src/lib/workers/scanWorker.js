const { analyzeCode } = require("../ai");
const { postPRReview, postCommitComment, postUpgradeComment } = require("../github");
const { saveFindings, updateScanStatus, getOrgByRepoId, incrementScanCount } = require("../../db/queries");
const { notifyIfNeeded } = require("../notifier");

const FREE_SCAN_LIMIT = 10;

/**
 * Core scan processor — called either directly (inline fallback) or by Bull.
 *
 * @param {object} data
 * @param {string} data.scanId
 * @param {string} data.repoId
 * @param {string} data.repoFullName
 * @param {string} data.diff
 * @param {object} data.context        ScanContext shape
 * @param {number} data.installationId
 * @param {number|null} [data.prNumber]   set for PR scans
 * @param {string|null} [data.commitSha]  set for push scans
 * @param {string} data.branch
 * @param {string} data.triggerType
 */
async function processScanJob(data) {
  const { scanId, repoId, repoFullName, diff, context, installationId, prNumber, commitSha, branch, triggerType } = data;
  const startedAt = Date.now();

  try {
    // Plan gate: check free-tier scan limit before running AI
    const org = await getOrgByRepoId(repoId);
    if (org && org.plan === "free") {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const scansThisMonth = org.scan_month === currentMonth ? (org.scan_count_month || 0) : 0;
      if (scansThisMonth >= FREE_SCAN_LIMIT) {
        console.log(`[worker] Scan ${scanId} skipped: free tier limit (${FREE_SCAN_LIMIT}/month) reached`);
        await updateScanStatus(scanId, [], 0, "failed");
        postUpgradeComment(repoFullName, { prNumber, commitSha }, installationId).catch((err) =>
          console.error("[worker] upgrade comment failed:", err.message)
        );
        return;
      }
    }

    const { issues, summary } = await analyzeCode(diff, context);

    if (issues.length > 0) {
      const findings = await saveFindings(scanId, issues);

      if (prNumber != null) {
        await postPRReview(repoFullName, prNumber, findings, summary, scanId, installationId);
      } else if (commitSha) {
        await postCommitComment(repoFullName, commitSha, findings, summary, scanId, installationId);
      }

      await notifyIfNeeded(repoId, repoFullName, findings, triggerType, branch, scanId);
    }

    await updateScanStatus(scanId, issues, Date.now() - startedAt);

    if (org) {
      incrementScanCount(org.id).catch((err) =>
        console.error("[worker] scan count increment failed:", err.message)
      );
    }
  } catch (err) {
    console.error(`[worker] Scan ${scanId} failed:`, err.message);
    await updateScanStatus(scanId, [], 0, "failed").catch(() => {});
    throw err; // re-throw so Bull can retry
  }
}

// Bull calls the exported function with (job) — unwrap job.data transparently
module.exports = (job) => processScanJob(job.data);
module.exports.processScanJob = processScanJob;
