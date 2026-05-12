const express = require("express");
const { analyzeSecuritySweep } = require("../lib/ai");
const { getSweepDiff } = require("../lib/github");
const { saveSweepScan, saveFindings, updateScanStatus } = require("../db/queries");
const { truncateDiff } = require("../lib/differ");

const router = express.Router();

function verifyInternalKey(req, res, next) {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) return next(); // dev: skip if not configured
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${key}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

router.post("/", verifyInternalKey, async (req, res) => {
  const { repoId, repoFullName, branch = "main", installationId } = req.body;

  if (!repoId || !repoFullName || !installationId) {
    return res.status(400).json({ error: "repoId, repoFullName, and installationId are required" });
  }

  const startedAt = Date.now();
  let scan;

  try {
    const diff = await getSweepDiff(repoFullName, branch, installationId);
    if (!diff || diff.length < 10) {
      return res.status(422).json({ error: "No diff found — push some commits first" });
    }

    scan = await saveSweepScan(repoId, branch);

    const context = {
      repo: repoFullName,
      branch,
      triggerType: "security_sweep",
      author: null,
    };

    const result = await analyzeSecuritySweep(truncateDiff(diff, 30000), context);
    const { issues = [], summary = "", threat_model, attack_chains, recommendations, scan_mode } = result;

    let findings = [];
    if (issues.length > 0) {
      findings = await saveFindings(scan.id, issues);
    }

    await updateScanStatus(scan.id, issues, Date.now() - startedAt);

    return res.json({ scanId: scan.id, findings, summary, scan_mode, threat_model, attack_chains, recommendations });
  } catch (err) {
    console.error("[sweep] Failed:", err.message);
    if (scan) {
      await updateScanStatus(scan.id, [], 0, "failed").catch(() => {});
    }
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
