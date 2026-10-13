// Admin-triggered scanner eval. Runs here, not in the web app, because a full
// sweep takes minutes — past a serverless function's ceiling.
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
  // Fail closed when the key is not configured.
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

/** Config the run executed under; a score means nothing without its setup. */
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
      // Missing fixtures is a deployment problem; don't create a run row for it.
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

    // Respond before the sweep starts so a proxy timeout can't lose the run id.
    res.status(202).json({runId, fixturesTotal, ...config});

    void runSweep(runId);
  },
);

// Every throw must be caught: an unhandled rejection would kill the worker mid-scan.
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
