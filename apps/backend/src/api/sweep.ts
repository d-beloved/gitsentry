import express, {Request, Response, NextFunction} from "express";
import {analyzeSecuritySweep} from "../lib/ai";
import {getSweepDiff} from "../lib/github";
import {resolveSecurityContext} from "../lib/securityContext";
import {
  saveSweepScan,
  saveFindings,
  updateScanStatus,
  verifyRepoInstallation,
  getOrgByRepoId,
  tryClaimSweepTrial,
  refundSweepTrial,
  tryClaimMonthlySweep,
  refundMonthlySweep,
  recordAiUsage,
} from "../db/queries";
import {truncateDiff} from "../lib/differ";

const router = express.Router();

function verifyInternalKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = process.env.INTERNAL_API_KEY;
  // If the key is not configured the endpoint must be closed
  if (!key) {
    console.error(
      "[sweep] INTERNAL_API_KEY is not configured — rejecting request",
    );
    res.status(503).json({error: "Endpoint not available"});
    return;
  }
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${key}`) {
    res.status(401).json({error: "Unauthorized"});
    return;
  }
  next();
}

router.post(
  "/",
  verifyInternalKey,
  async (req: Request, res: Response): Promise<void> => {
    const {
      repoId,
      repoFullName,
      branch = "main",
      installationId,
    } = req.body as {
      repoId?: string;
      repoFullName?: string;
      branch?: string;
      installationId?: number;
    };

    if (!repoId || !repoFullName || !installationId) {
      res
        .status(400)
        .json({error: "repoId, repoFullName, and installationId are required"});
      return;
    }

    // Verify the repo actually belongs to this installation
    const repoOwned = await verifyRepoInstallation(repoId, installationId);
    if (!repoOwned) {
      res.status(403).json({error: "Forbidden"});
      return;
    }

    // Enforce per-plan sweep limits:
    //   Free    — 1 lifetime trial (sweep_trials_used)
    //   Starter — 1 / month        (try_claim_sweep RPC)
    //   Pro     — 10 / month       (try_claim_sweep RPC)
    const SWEEP_LIMITS: Record<string, number> = {free: 1, starter: 1, pro: 10};

    const org = await getOrgByRepoId(repoId);
    const plan = org?.plan ?? "free";
    const isPro =
      plan === "pro" &&
      (org?.subscription_status === "active" || org?.subscription_status == null);

    if (!org) {
      res.status(403).json({error: "Organisation not found for this repo"});
      return;
    }

    let claimedSweep = false;
    let usedMonthlyQuota = false;

    if (plan === "free") {
      // One-time lifetime trial for free users
      claimedSweep = await tryClaimSweepTrial(org.id);
      if (!claimedSweep) {
        res.status(402).json({
          error: "Your 1 free security sweep has already been used. Upgrade to Starter or Pro for monthly sweeps.",
          upgradeUrl: `${process.env.PRODUCT_URL}/dashboard/billing`,
        });
        return;
      }
    } else {
      // Starter (1/month) and Pro (10/month) use the monthly quota
      const sweepLimit = SWEEP_LIMITS[plan] ?? 1;
      claimedSweep = await tryClaimMonthlySweep(org.id, sweepLimit, plan, org.sweep_month ?? null);
      usedMonthlyQuota = true;
      if (!claimedSweep) {
        const limitLabel = sweepLimit === 1 ? "1 sweep" : `${sweepLimit} sweeps`;
        res.status(402).json({
          error: `Monthly sweep limit reached (${limitLabel}/month on the ${plan} plan).${isPro ? "" : " Upgrade to Pro for 10 sweeps/month."}`,
          upgradeUrl: `${process.env.PRODUCT_URL}/dashboard/billing`,
        });
        return;
      }
    }

    const startedAt = Date.now();
    let scan: {id: string} | undefined;

    try {
      const diff = await getSweepDiff(repoFullName, branch, installationId);
      if (!diff || diff.length < 10) {
        // Refund the slot — no scan was actually run
        if (usedMonthlyQuota) await refundMonthlySweep(org.id).catch(() => {});
        else await refundSweepTrial(org.id).catch(() => {});
        res.status(422).json({error: "No diff found — push some commits first"});
        return;
      }

      scan = await saveSweepScan(repoId, branch);

      const { repoSecurityContext, classification } = await resolveSecurityContext({
        repoId,
        repoFullName,
        branch,
        installationId,
        diff,
        scanId: scan.id,
      }).catch((err: Error) => {
        console.warn("[sweep] resolveSecurityContext failed — sweeping without it:", err.message);
        return { repoSecurityContext: "", classification: undefined };
      });

      const context = {
        repo: repoFullName,
        branch,
        triggerType: "security_sweep" as const,
        author: null,
        repoSecurityContext,
      };

      const result = await analyzeSecuritySweep(
        truncateDiff(diff, 30000),
        context,
        classification,
      );
      const {
        issues = [],
        summary = "",
        threat_model,
        attack_chains,
        recommendations,
        scan_mode,
        tokens_in = 0,
        tokens_out = 0,
        model_name,
      } = result;

      let findings: Awaited<ReturnType<typeof saveFindings>> = [];
      if (issues.length > 0) {
        findings = await saveFindings(scan.id, issues);
      }

      recordAiUsage({
        surface: "security_sweep",
        model: model_name ?? "",
        tokensIn: tokens_in,
        tokensOut: tokens_out,
        scanId: scan.id,
        repoId,
      }).catch((err: Error) => console.error("[sweep] recordAiUsage failed:", err.message));

      await updateScanStatus(scan.id, issues, Date.now() - startedAt, "complete", {
        tokensIn: tokens_in,
        tokensOut: tokens_out,
        modelName: model_name,
      });

      res.json({
        scanId: scan.id,
        findings,
        summary,
        scan_mode,
        threat_model,
        attack_chains,
        recommendations,
      });
    } catch (err) {
      console.error("[sweep] Failed:", err);
      if (scan) {
        await updateScanStatus(scan.id, [], 0, "failed").catch(() => {});
      }
      // Refund the slot on unexpected failure so the user isn't charged for a broken sweep
      if (usedMonthlyQuota) await refundMonthlySweep(org.id).catch(() => {});
      else await refundSweepTrial(org.id).catch(() => {});
      // Return a generic message — never expose raw Error.message to callers.
      res.status(500).json({error: "Sweep failed. Please try again."});
    }
  },
);

export default router;
