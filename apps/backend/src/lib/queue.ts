import Bull from "bull";
import type { ScanJobData } from "../../../../packages/scanner-contract/types";
import { processScanJob } from "./workers/scanWorker";

let scanQueue: Bull.Queue<ScanJobData> | null = null;

// Defaults to 1: parallel long AI calls on one provider account cause timeouts.
// The reaper's SCAN_QUEUE_TIMEOUT_MINUTES is sized against the resulting queue wait.
function workerConcurrency(): number {
  const raw = process.env.SCAN_WORKER_CONCURRENCY;
  if (!raw) return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(`[queue] SCAN_WORKER_CONCURRENCY="${raw}" is not a positive integer — using 1`);
    return 1;
  }
  if (parsed > 1) {
    console.log(`[queue] Worker concurrency set to ${parsed}`);
  }
  return parsed;
}

if (process.env.REDIS_URL) {
  try {
    const isTLS = process.env.REDIS_URL.startsWith("rediss://");
    // Verify TLS by default; self-signed managed Redis must opt out explicitly.
    const rejectUnauthorized = process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false";
    scanQueue = new Bull<ScanJobData>("scan", process.env.REDIS_URL, {
      redis: {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        ...(isTLS ? { tls: { rejectUnauthorized } } : {}),
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });

    scanQueue.on("error", (err) => console.error("[queue] Bull error:", err.message));
    scanQueue.on("failed", (job, err) =>
      console.error(
        `[queue] Job ${job.id} failed (attempt ${job.attemptsMade}):`,
        err.message,
      ),
    );

    // Deferred to avoid a circular require with the worker.
    setImmediate(() => {
      import("./workers/scanWorker").then(({ default: processor }) => {
        scanQueue!.process(workerConcurrency(), processor);
      }).catch((err) => console.error("[queue] Failed to load worker:", err));
    });

    console.log("[queue] Bull queue initialized with Redis");
  } catch (err) {
    console.warn("[queue] Failed to init Bull queue:", (err as Error).message);
    scanQueue = null;
  }
} else {
  console.log("[queue] REDIS_URL not set — scanning inline (no queue)");
}

export { scanQueue };

/** Fire-and-forget; falls back to an inline scan if Bull is unreachable or the add times out. */
export function dispatchScan(jobData: ScanJobData, label: string): void {
  if (scanQueue) {
    Promise.race([
      scanQueue.add(jobData),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("queue timeout")), 5_000)
      ),
    ])
      .then(() => { /* queued */ })
      .catch((err: Error) => {
        console.warn(`[${label}] Bull add failed, scanning inline:`, err.message);
        processScanJob(jobData).catch((e: Error) =>
          console.error(`[${label}] inline scan failed:`, e.message)
        );
      });
  } else {
    processScanJob(jobData).catch((err: Error) =>
      console.error(`[${label}] inline scan failed:`, err.message)
    );
  }
}
