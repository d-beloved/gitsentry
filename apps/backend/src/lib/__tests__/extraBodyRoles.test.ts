/**
 * Pins which host knobs each kind of call carries.
 *
 * The wiring is the part worth testing: a scan that quietly sends the sweep's
 * reasoning settings — or none at all — costs latency and money on every PR and
 * shows up in no log line. The provider is faked, so nothing here makes a real
 * call; the assertions are entirely about what the request was built with.
 */
import type { AIProvider, GenerateRequest } from "../../../../../packages/ai-provider";
import type { ScanContext } from "../../../../../packages/scanner-contract/types";

const DIFF = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
`;

const CONTEXT: ScanContext = {
  repo: "acme/api",
  branch: "main",
  triggerType: "pull_request",
  author: null,
};

/**
 * Reloads ai.ts under the given env with a recording provider in place.
 *
 * The role vars are read once at module load — that is the point, so a bad one
 * fails the deploy rather than a scan — so each case needs a fresh module
 * registry rather than just a different process.env.
 */
async function loadAi(
  env: Record<string, string | undefined>,
  respond: (req: GenerateRequest) => string = () => '{"issues":[],"summary":"clean"}',
) {
  jest.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const pkg = await import("../../../../../packages/ai-provider");
  const calls: GenerateRequest[] = [];
  const fake: AIProvider = {
    name: "fake",
    generate: async (req) => {
      calls.push(req);
      return {
        text: respond(req),
        tokensIn: 1,
        tokensOut: 1,
        cachedTokens: 0,
        model: req.model,
      };
    },
  };
  pkg.setProvider(fake);

  const ai = await import("../ai");
  return { ai, calls };
}

const ROLE_VARS = [
  "AI_EXTRA_BODY",
  "AI_SCAN_EXTRA_BODY",
  "AI_SWEEP_EXTRA_BODY",
  "AI_DISCOVERY_EXTRA_BODY",
  "AI_VERIFY_EXTRA_BODY",
];

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  jest.resetModules();
});
beforeEach(() => {
  for (const key of ROLE_VARS) delete process.env[key];
});

describe("per-role extra bodies", () => {
  it("sends each role its own knobs", async () => {
    const { ai, calls } = await loadAi({
      AI_SCAN_EXTRA_BODY: '{"reasoning_effort":"low"}',
      AI_SWEEP_EXTRA_BODY: '{"reasoning_effort":"max"}',
      AI_DISCOVERY_EXTRA_BODY: '{"thinking":{"type":"disabled"}}',
    });

    await ai.analyzeCode(DIFF, CONTEXT, { mode: "diff_scan" });
    await ai.analyzeCode(DIFF, CONTEXT, { mode: "security_sweep" });
    await ai.classifyProject(["src/api.ts"], "acme/api");

    expect(calls.map((c) => c.extraBody)).toEqual([
      { reasoning_effort: "low" },
      { reasoning_effort: "max" },
      { thinking: { type: "disabled" } },
    ]);
  });

  it("leaves the global setting to the provider when a role says nothing", async () => {
    // The global lives on the provider, not on the request — a role that sets
    // nothing must send undefined rather than an empty object that would look
    // like a deliberate override.
    const { ai, calls } = await loadAi({ AI_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' });

    await ai.analyzeCode(DIFF, CONTEXT, { mode: "diff_scan" });

    expect(calls[0].extraBody).toBeUndefined();
  });

  it("refuses a malformed role var at load, naming the var", async () => {
    await expect(loadAi({ AI_SWEEP_EXTRA_BODY: "{oops}" })).rejects.toThrow(
      /AI_SWEEP_EXTRA_BODY is not valid JSON/,
    );
  });

  it("sends the judge its own knobs on the verification pass", async () => {
    // The judge only runs when the scan found something, so the scan has to
    // return a finding that survives the hallucination filter — hence a path
    // that is actually in the diff.
    const { ai, calls } = await loadAi(
      {
        AI_SCAN_EXTRA_BODY: '{"thinking":{"type":"disabled"}}',
        AI_VERIFY_EXTRA_BODY: '{"reasoning_effort":"high"}',
      },
      (req) =>
        req.schemaName === "verdicts"
          ? '{"verdicts":[{"index":0,"verdict":"confirmed","reason":"real"}]}'
          : JSON.stringify({
              issues: [
                {
                  category: "missing_auth",
                  severity: "high",
                  confidence: "high",
                  file_path: "src/api.ts",
                  line_number: 2,
                  description: "no auth check",
                  suggestion: "add one",
                },
              ],
              summary: "one finding",
            }),
    );

    const result = await ai.analyzeCode(DIFF, CONTEXT, { mode: "diff_scan" });

    expect(result.issues).toHaveLength(1);
    expect(calls.map((c) => c.schemaName)).toEqual(["analysis", "verdicts"]);
    expect(calls[1].extraBody).toEqual({ reasoning_effort: "high" });
  });
});
