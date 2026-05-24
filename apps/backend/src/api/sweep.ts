import express, { Request, Response, NextFunction } from "express";
import { analyzeSecuritySweep } from "../lib/ai";
import { getSweepDiff } from "../lib/github";
import { saveSweepScan, saveFindings, updateScanStatus } from "../db/queries";
import { truncateDiff } from "../lib/differ";

const router = express.Router();

function verifyInternalKey(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) return next();
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${key}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.post("/", verifyInternalKey, async (req: Request, res: Response): Promise<void> => {
  const { repoId, repoFullName, branch = "main", installationId } = req.body as {
    repoId?: string;
    repoFullName?: string;
    branch?: string;
    installationId?: number;
  };

  if (!repoId || !repoFullName || !installationId) {
    res.status(400).json({ error: "repoId, repoFullName, and installationId are required" });
    return;
  }

  const startedAt = Date.now();
  let scan: { id: string } | undefined;

  try {
    const diff = await getSweepDiff(repoFullName, branch, installationId);
    if (!diff || diff.length < 10) {
      res.status(422).json({ error: "No diff found — push some commits first" });
      return;
    }

    scan = await saveSweepScan(repoId, branch);

    const context = {
      repo: repoFullName,
      branch,
      triggerType: "security_sweep" as const,
      author: null,
    };

    const result = await analyzeSecuritySweep(truncateDiff(diff, 30000), context);
    const {
      issues = [],
      summary = "",
      threat_model,
      attack_chains,
      recommendations,
      scan_mode,
    } = result;

    let findings: Awaited<ReturnType<typeof saveFindings>> = [];
    if (issues.length > 0) {
      findings = await saveFindings(scan.id, issues);
    }

    await updateScanStatus(scan.id, issues, Date.now() - startedAt);

    res.json({ scanId: scan.id, findings, summary, scan_mode, threat_model, attack_chains, recommendations });
  } catch (err) {
    console.error("[sweep] Failed:", (err as Error).message);
    if (scan) {
      await updateScanStatus(scan.id, [], 0, "failed").catch(() => {});
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
