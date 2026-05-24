import Bull from "bull";
import type { ScanJobData } from "../../../../packages/scanner-contract/types";

let scanQueue: Bull.Queue<ScanJobData> | null = null;

if (process.env.REDIS_URL) {
  try {
    scanQueue = new Bull<ScanJobData>("scan", process.env.REDIS_URL, {
      redis: {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
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
        scanQueue!.process(processor);
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
