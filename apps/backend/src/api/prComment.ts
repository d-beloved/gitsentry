import express, {Request, Response} from "express";
import {requireInternalKey} from "./internalAuth";
import {getPRCommentTargets} from "../db/queries";
import {refreshPRComment} from "../lib/prComment";

const router = express.Router();

const MAX_SCAN_IDS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const verifyInternalKey = requireInternalKey("pr-comment");

// Called by the dashboard after findings are resolved or dismissed, so each affected PR's comment
// stops listing them without waiting for the next push.
router.post(
  "/refresh",
  verifyInternalKey,
  async (req: Request, res: Response): Promise<void> => {
    const scanIds = (req.body as {scanIds?: unknown})?.scanIds;
    if (
      !Array.isArray(scanIds) ||
      !scanIds.length ||
      scanIds.length > MAX_SCAN_IDS ||
      !scanIds.every((id) => typeof id === "string" && UUID.test(id))
    ) {
      res.status(400).json({error: `scanIds must be 1–${MAX_SCAN_IDS} scan ids`});
      return;
    }

    const targets = await getPRCommentTargets([...new Set(scanIds as string[])]).catch((err: Error) => {
      console.error("[pr-comment] target lookup failed:", err.message);
      return null;
    });
    if (!targets) {
      res.status(500).json({error: "Lookup failed"});
      return;
    }

    const results = await Promise.allSettled(targets.map((t) => refreshPRComment(t)));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(
          `[pr-comment] refresh failed for ${targets[i].repoFullName}#${targets[i].prNumber}:`,
          (r.reason as Error)?.message,
        );
      }
    });

    res.json({
      refreshed: results.filter((r) => r.status === "fulfilled" && r.value).length,
      failed: results.filter((r) => r.status === "rejected").length,
    });
  },
);

export default router;
