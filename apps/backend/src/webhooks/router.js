const express = require("express");
const crypto = require("crypto");
const { handlePR } = require("./pullRequest");
const { handleCheckRun } = require("./checkRun");
const { handleInstallation } = require("./installation");
const { handleInstallationRepositories } = require("./installationRepositories");
const { handleRepository } = require("./repository");
const { handleGithubAppAuthorization } = require("./githubAppAuthorization");

const router = express.Router();

function verifySignature(req) {
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;

  const hmac = crypto.createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET);
  const digest = "sha256=" + hmac.update(req.rawBody).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
  } catch {
    return false;
  }
}

router.post("/", async (req, res) => {
  if (!verifySignature(req)) {
    console.warn("Webhook signature verification failed");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.headers["x-github-event"];
  const delivery = req.headers["x-github-delivery"];

  // Ack immediately — GitHub requires a response within 10s
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

module.exports = router;
