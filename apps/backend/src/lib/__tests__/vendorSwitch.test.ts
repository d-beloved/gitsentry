// Pins the runtime provider switch: no cross-provider fallback, and refused switches keep the current provider.
import type { AIProvider, GenerateRequest } from "../../../../../packages/ai-provider";
import type { ScanContext } from "../../../../../packages/scanner-contract/types";

const DIFF = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
`;

const CONTEXT: ScanContext = { repo: "acme/api", branch: "main", triggerType: "pull_request", author: null };

const ANTHROPIC_ENV = {
  AI_ANTHROPIC_API_KEY: "sk-test",
  AI_ANTHROPIC_SCAN_MODEL: "scan-model-a",
  AI_ANTHROPIC_SWEEP_MODEL: "sweep-model-a",
  AI_ANTHROPIC_DISCOVERY_MODEL: "scan-model-a",
  AI_ANTHROPIC_SWEEP_EXTRA_BODY: '{"output_config":{"effort":"high"}}',
};

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  jest.resetModules();
});

function setEnv(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("vendor-scoped env", () => {
  it("never lets a vendor inherit another vendor's model or key", async () => {
    setEnv({ AI_SCAN_MODEL: "other-scan-model", AI_ANTHROPIC_API_KEY: "k" });
    const env = await import("../../../../../packages/ai-provider/env");
    expect(env.envFor("anthropic", "SCAN_MODEL")).toBeUndefined();
    expect(() => env.requireEnvFor("anthropic", "SCAN_MODEL")).toThrow(/AI_ANTHROPIC_SCAN_MODEL is not set/);
  });

  it("shares app-level budgets unless the vendor overrides them", async () => {
    setEnv({ AI_SCAN_TIMEOUT_MS: "300000", AI_ANTHROPIC_VERIFY_TIMEOUT_MS: "900000" });
    const env = await import("../../../../../packages/ai-provider/env");
    expect(env.envFor("anthropic", "SCAN_TIMEOUT_MS")).toBe("300000");
    expect(env.envFor("anthropic", "VERIFY_TIMEOUT_MS")).toBe("900000");
  });

  it("rejects an AI_PROVIDER it does not know", async () => {
    setEnv({ AI_PROVIDER: "openai" });
    const env = await import("../../../../../packages/ai-provider/env");
    expect(() => env.activeVendor()).toThrow(/AI_PROVIDER must be one of/);
  });

  it("lists only vendors with a key as configured", async () => {
    setEnv({ AI_ANTHROPIC_API_KEY: "k", AI_OPENAI_COMPAT_API_KEY: undefined, AI_GEMINI_API_KEY: undefined });
    const env = await import("../../../../../packages/ai-provider/env");
    expect(env.configuredVendors()).toEqual(["anthropic"]);
  });
});

describe("scanner follows the active vendor per call", () => {
  it("routes the next scan to the newly selected vendor's model and knobs", async () => {
    setEnv(ANTHROPIC_ENV);
    const pkg = await import("../../../../../packages/ai-provider");
    const calls: GenerateRequest[] = [];
    const fake: AIProvider = {
      name: "fake",
      generate: async (req) => {
        calls.push(req);
        return { text: '{"issues":[],"summary":"clean"}', tokensIn: 1, tokensOut: 1, cachedTokens: 0, model: req.model };
      },
    };
    pkg.setProvider(fake);
    const ai = await import("../ai");

    await ai.analyzeCode(DIFF, CONTEXT, { mode: "security_sweep" });
    pkg.setActiveVendor("anthropic");
    await ai.analyzeCode(DIFF, CONTEXT, { mode: "security_sweep" });

    expect(calls.map((c) => c.model)).toEqual(["test-sweep-model", "sweep-model-a"]);
    expect(calls[1].extraBody).toEqual({ output_config: { effort: "high" } });
    expect(calls[1].system).toMatch(/taint tracking/i);
    expect(calls[1].prompt).toContain("<untrusted_input>");
  });

  it("refuses a vendor missing a required model", async () => {
    setEnv({ ...ANTHROPIC_ENV, AI_ANTHROPIC_DISCOVERY_MODEL: undefined });
    const ai = await import("../ai");
    expect(() => ai.assertScannerConfig("anthropic")).toThrow(/AI_ANTHROPIC_DISCOVERY_MODEL is not set/);
  });
});

describe("admin switch sync", () => {
  async function loadSync(requested: unknown) {
    const upserts: { key: string; value: Record<string, unknown> }[] = [];
    jest.doMock("../../db/client", () => ({
      supabase: {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { value: { vendor: requested } }, error: null }),
            }),
          }),
          upsert: async (row: { key: string; value: Record<string, unknown> }) => {
            upserts.push(row);
            return { error: null };
          },
        }),
      },
    }));
    const settings = await import("../aiSettings");
    const pkg = await import("../../../../../packages/ai-provider");
    return { settings, pkg, upserts };
  }

  it("applies a fully configured vendor and reports it back", async () => {
    setEnv(ANTHROPIC_ENV);
    const { settings, pkg, upserts } = await loadSync("anthropic");
    await settings.syncActiveVendor();
    expect(pkg.activeVendor()).toBe("anthropic");
    expect(upserts[0].value).toMatchObject({ active: "anthropic", requested: "anthropic", error: null });
    expect(upserts[0].value.available).toContain("anthropic");
  });

  it("keeps the current vendor when the requested one is not configured", async () => {
    setEnv({ AI_OPENAI_COMPAT_API_KEY: undefined });
    const { settings, pkg, upserts } = await loadSync("openai_compat");
    await settings.syncActiveVendor();
    expect(pkg.activeVendor()).toBeNull();
    expect(upserts[0].value).toMatchObject({ active: null, requested: "openai_compat" });
    expect(upserts[0].value.error).toMatch(/AI_OPENAI_COMPAT_API_KEY is not set/);
  });
});
