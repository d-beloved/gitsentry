const express = require("express");
const crypto = require("crypto");
const { handlePR } = require("./pullRequest");
const { handlePush } = require("./push");
const { handleInstallation } = require("./installation");

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
    if (event === "push") await handlePush(req.body);
    if (event === "installation") await handleInstallation(req.body);
  } catch (err) {
    console.error(`[webhook] error processing event=${event} delivery=${delivery}:`, err);
  }
});

module.exports = router;
