import Bull from "bull";
import type { ScanJobData } from "../../../../packages/scanner-contract/types";
import { processScanJob } from "./workers/scanWorker";

let scanQueue: Bull.Queue<ScanJobData> | null = null;

/**
 * How many scans the worker runs at once. One by default, deliberately: the
 * scan's cost is a single long AI call, and running several of those in
 * parallel against one provider account is what produced the timeouts this
 * queue was tuned around. The knob exists so that can be measured on a real
 * deployment — raise SCAN_WORKER_CONCURRENCY, watch the AI timeout rate and
 * p95 scan duration, and roll it back with a config change rather than a
 * release. Raising it also shortens queue waits, which is what
 * SCAN_QUEUE_TIMEOUT_MINUTES in the reaper is sized against.
 */
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
    // TLS certificates are verified by default. Some legacy managed Redis
    // providers (e.g. old Heroku Redis plans) serve self-signed certs; opt
    // out explicitly with REDIS_TLS_REJECT_UNAUTHORIZED=false — never by default.
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

    // Wire the worker after the module is fully loaded to avoid circular requires
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

/**
 * Fire-and-forget scan dispatch. Tries Bull with a 5s timeout; falls back to
 * inline processScanJob if Bull is unreachable or the add times out. Never
 * blocks the caller — safe to call without await.
 */
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
