import express, { Request, Response } from "express";
import crypto from "crypto";
import { handlePR } from "./pullRequest";
import { handleCheckRun } from "./checkRun";
import { handleInstallation } from "./installation";
import { handleInstallationRepositories } from "./installationRepositories";
import { handleRepository } from "./repository";
import { handleGithubAppAuthorization } from "./githubAppAuthorization";

const router = express.Router();

function verifySignature(req: Request): boolean {
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;

  const hmac = crypto.createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET!);
  const digest = "sha256=" + hmac.update(req.rawBody!).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(sig as string), Buffer.from(digest));
  } catch {
    return false;
  }
}

router.post("/", async (req: Request, res: Response): Promise<void> => {
  if (!verifySignature(req)) {
    console.warn("Webhook signature verification failed");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const event = req.headers["x-github-event"] as string;
  const delivery = req.headers["x-github-delivery"] as string;

  res.sendStatus(202);

  console.log(`[webhook] event=${event} delivery=${delivery}`);

  try {
    if (event === "pull_request") await handlePR(req.body);
    if (event === "check_run") await handleCheckRun(req.body);
    if (event === "installation") await handleInstallation(req.body);
    if (event === "installation_repositories") await handleInstallationRepositories(req.body);
    if (event === "repository") await handleRepository(req.body);
    if (event === "github_app_authorization") await handleGithubAppAuthorization(req.body);
  } catch (err) {
    console.error(`[webhook] error processing event=${event} delivery=${delivery}:`, err);
  }
});

export default router;
