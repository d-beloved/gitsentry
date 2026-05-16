const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const express = require("express");
const rateLimit = require("express-rate-limit");
const webhookRouter = require("./webhooks/router");
const sweepRouter = require("./api/sweep");

const app = express();

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // GitHub sends at most a handful per push; 120/min is generous
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

// Capture raw body for HMAC signature verification before JSON parsing
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "gitsentry-dev-backend" }));

app.use("/webhook", webhookLimiter, webhookRouter);
app.use("/api/sweep", sweepRouter);

// 404 fallback
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gitsentry.dev backend listening on port ${PORT}`);
  console.log(`Webhook endpoint: POST http://localhost:${PORT}/webhook`);
});

module.exports = app;
