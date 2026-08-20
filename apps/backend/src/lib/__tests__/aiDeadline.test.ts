import { aiTimeoutMs, withAIDeadline, AITimeoutError } from "../aiDeadline";

describe("aiTimeoutMs", () => {
  const saved = {...process.env};
  afterEach(() => {
    process.env = {...saved};
    jest.restoreAllMocks();
  });

  it("uses the default when unset", () => {
    delete process.env.AI_SCAN_TIMEOUT_MS;
    delete process.env.GEMINI_SCAN_TIMEOUT_MS;
    expect(aiTimeoutMs("SCAN", 300_000)).toBe(300_000);
  });

  it("reads an override", () => {
    process.env.AI_SCAN_TIMEOUT_MS = "600000";
    expect(aiTimeoutMs("SCAN", 300_000)).toBe(600_000);
  });

  it.each(["nonsense", "0", "-1"])(
    "falls back to the default on %p rather than throwing at load",
    (value) => {
      jest.spyOn(console, "warn").mockImplementation(() => {});
      process.env.AI_SCAN_TIMEOUT_MS = value;
      expect(aiTimeoutMs("SCAN", 300_000)).toBe(300_000);
    },
  );
});

describe("withAIDeadline", () => {
  it("aborts the call and throws AITimeoutError past the budget", async () => {
    let signal: AbortSignal | undefined;
    const call = (opts: {signal: AbortSignal}) => {
      signal = opts.signal;
      return new Promise<string>(() => {}); // never settles
    };

    await expect(withAIDeadline("scan", 10, call)).rejects.toBeInstanceOf(AITimeoutError);
    // The abort is what frees the socket — racing the promise alone would leave
    // the request in flight for as long as the provider takes.
    expect(signal?.aborted).toBe(true);
  });

  it("passes the budget through and leaves a fast call untouched", async () => {
    const result = await withAIDeadline("scan", 5_000, async (opts) => {
      expect(opts.timeout).toBe(5_000);
      expect(opts.signal.aborted).toBe(false);
      return "ok";
    });
    expect(result).toBe("ok");
  });
});
