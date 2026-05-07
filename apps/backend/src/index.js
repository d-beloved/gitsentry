require("dotenv").config();
const express = require("express");
const webhookRouter = require("./webhooks/router");

const app = express();

// Capture raw body for HMAC signature verification before JSON parsing
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "gitsentry-backend" }));

app.use("/webhook", webhookRouter);

// 404 fallback
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GitSentry backend listening on port ${PORT}`);
  console.log(`Webhook endpoint: POST http://localhost:${PORT}/webhook`);
});

module.exports = app;
