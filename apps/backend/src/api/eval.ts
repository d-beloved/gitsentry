/**
 * Admin-triggered scanner eval.
 *
 * The sweep lives here rather than in the web app for two reasons: the fixtures
 * and analyzeCode are in this repo, and twelve sequential scans take minutes —
 * comfortably past a serverless function's ceiling. /admin/eval POSTs here with
 * the internal key, gets a run id back immediately, and reads progress from
 * Supabase while the sweep continues in this process.
 */
import express, {Request, Response, NextFunction} from "express";
import {runEval, loadFixtures} from "../../../../eval/harness";
import {
  getProvider,
  aiEnv,
  OpenAICompatProvider,
} from "../../../../packages/ai-provider";
import {
  createEvalRun,
  saveEvalCase,
  completeEvalRun,
  failEvalRun,
  evalRunInFlight,
} from "../db/queries";

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
      "[eval] INTERNAL_API_KEY is not configured — rejecting request",
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

/** Snapshot of the config a run executed under. Stored on the run because env
 *  changes and a score means nothing without the setup that produced it. */
function currentConfig() {
  const provider = getProvider();
  return {
    provider: provider.name,
    model: aiEnv("SCAN_MODEL") ?? "unknown",
    verifierEnabled: process.env.VERIFY_FINDINGS !== "off",
    structuredMode:
      provider instanceof OpenAICompatProvider ? provider.structuredMode : null,
  };
}

router.post(
  "/",
  verifyInternalKey,
  async (req: Request, res: Response): Promise<void> => {
    const {label} = req.body as {label?: string};

    if (await evalRunInFlight()) {
      res.status(409).json({
        error: "An eval run is already in progress",
      });
      return;
    }

    let fixturesTotal: number;
    try {
      fixturesTotal = loadFixtures().length;
    } catch (err) {
      // Missing fixtures is a deployment problem, not a run failure — say so
      // before creating a run row that would just sit there failed.
      res.status(500).json({error: (err as Error).message});
      return;
    }

    const config = currentConfig();
    let runId: string;
    try {
      runId = await createEvalRun({
        label: label?.trim() || null,
        ...config,
        fixturesTotal,
      });
    } catch (err) {
      res.status(500).json({error: (err as Error).message});
      return;
    }

    // Respond before the sweep starts. The caller polls Supabase for progress;
    // holding the connection open for three minutes buys nothing and loses the
    // run id if the proxy times out first.
    res.status(202).json({runId, fixturesTotal, ...config});

    void runSweep(runId);
  },
);

/** Fire-and-forget sweep. Every throw is caught and recorded — an unhandled
 *  rejection here would take down the worker mid-scan for real customers. */
async function runSweep(runId: string): Promise<void> {
  console.log(`[eval] run ${runId} started`);
  try {
    let done = 0;
    const result = await runEval(async (c) => {
      done++;
      await saveEvalCase(runId, c, done);
    });
    await completeEvalRun(runId, result);
    console.log(
      `[eval] run ${runId} complete — ${result.detected}/${result.expectedTotal} recall, ` +
        `${result.cleanFPs} clean FPs, ${(result.durationMs / 1000).toFixed(0)}s`,
    );
  } catch (err) {
    console.error(`[eval] run ${runId} failed:`, err);
    await failEvalRun(runId, (err as Error).message ?? String(err));
  }
}

export default router;
