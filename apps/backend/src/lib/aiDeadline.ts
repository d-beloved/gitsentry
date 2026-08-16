/**
 * Wall-clock budgets for AI provider calls.
 *
 * Lives in its own module because both ai.ts and verifier.ts need it and ai.ts
 * already imports verifier.ts — putting it in either would make that cycle.
 */

/**
 * Thrown when an AI call exceeds its wall-clock budget. Typed so callers can
 * treat it as terminal rather than retryable: the input is unchanged between
 * attempts, so a prompt that blew the budget once will do it again, and with the
 * Bull worker at concurrency 1 each retry blocks every other repo's scan behind it.
 */
export class AITimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AITimeoutError";
  }
}

/**
 * Runs an AI call under a hard wall-clock budget.
 *
 * The SDK is handed both an AbortSignal and its own `timeout`, because racing a
 * promise only abandons the *result* — it leaves the underlying request in
 * flight, holding a socket for however long the API actually takes. Under load
 * that turns one slow call into sustained connection pressure, which is exactly
 * the shape of failure that made these timeouts cluster. Aborting is a
 * client-side operation (work already done is still billed), but it frees the
 * socket immediately instead of 120s later.
 *
 * The timer is always cleared, so a call that returns quickly doesn't leave a
 * live handle pinning the prompt closure in memory until the budget expires.
 */
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
