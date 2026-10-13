// Separate module to avoid an ai.ts <-> verifier.ts import cycle.
import { activeVendor, envFor, type Vendor } from "../../../../packages/ai-provider/env";

/** Terminal, not retryable: the same input would blow the budget again and block the queue. */
export class AITimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AITimeoutError";
  }
}

// Racing alone would leave the request in flight holding a socket, so the call
// is also aborted. The timer is always cleared so it can't pin the closure.
export async function withAIDeadline<T>(
  label: string,
  timeoutMs: number,
  call: (opts: {signal: AbortSignal; timeout: number}) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AITimeoutError(`[ai] ${label} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      call({signal: controller.signal, timeout: timeoutMs}),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Reads `AI_<name>_TIMEOUT_MS`; an unparseable value falls back to the default
// with a warning rather than throwing at load.
export function aiTimeoutMs(name: string, defaultMs: number): number {
  return aiTimeoutMsFor(activeVendor(), name, defaultMs);
}

/** Per-vendor: `AI_<VENDOR>_<name>_TIMEOUT_MS` wins over the unprefixed name. */
export function aiTimeoutMsFor(vendor: Vendor | null, name: string, defaultMs: number): number {
  const raw = envFor(vendor, `${name}_TIMEOUT_MS`);
  if (!raw) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[ai] ${name}_TIMEOUT_MS="${raw}" is not a positive number — using ${defaultMs}ms`,
    );
    return defaultMs;
  }
  return parsed;
}
