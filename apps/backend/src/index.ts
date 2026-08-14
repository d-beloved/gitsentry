import express, {Request, Response} from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import webhookRouter from "./webhooks/router";
import sweepRouter from "./api/sweep";
import rescanRouter from "./api/rescan";
import {startReaper} from "./lib/reaper";

const app = express();

// Render (and most cloud platforms) sit behind a reverse proxy that sets
// X-Forwarded-For. Without this, express-rate-limit throws a ValidationError
// and leaves requests hanging instead of responding.
app.set("trust proxy", 1);

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3201"];

app.use(cors({origin: ALLOWED_ORIGINS, credentials: true}));

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {error: "Too many requests"},
});

const sweepLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {error: "Too many requests"},
});

app.use(
  express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  }),
);

app.get("/health", (_req: Request, res: Response) =>
  res.json({status: "ok", service: "gitsentry-dev-backend"}),
);

app.use("/webhook", webhookLimiter, webhookRouter);
app.use("/api/sweep", sweepLimiter, sweepRouter);
app.use("/api/rescan", sweepLimiter, rescanRouter);

app.use((_req: Request, res: Response) =>
  res.status(404).json({error: "Not found"}),
);

const PORT = process.env.PORT || 3200;
app.listen(PORT, () => {
  console.log(`Gitsentry.dev backend listening on port ${PORT}`);
  console.log(`Webhook endpoint: POST http://localhost:${PORT}/webhook`);
  startReaper();
});

export default app;
