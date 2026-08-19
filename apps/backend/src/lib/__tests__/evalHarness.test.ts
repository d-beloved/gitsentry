/**
 * Tests for the eval scoring engine.
 *
 * The harness is the only thing standing between "the scanner got worse" and
 * "we shipped it anyway", and it now feeds two consumers — the CLI gate and the
 * admin dashboard. Miscounting here is invisible: it produces a plausible
 * number, not an error. So the cases pinned below are the ones where a wrong
 * score would still look reasonable — a hit credited on the right category in
 * the wrong file, a false positive on a clean fixture counted as an informational
 * extra, and a scan that errored quietly dropping out of the recall denominator.
 */
import type { AIAnalysisResult } from "../../../../../packages/scanner-contract/types";

jest.mock("../ai", () => ({ analyzeCode: jest.fn() }));

import { analyzeCode } from "../ai";
import { runCase, type Fixture } from "../../../../../eval/harness";

const mockAnalyze = analyzeCode as jest.MockedFunction<typeof analyzeCode>;

function finding(category: string, file: string) {
  return {
    severity: "high" as const,
    category: category as never,
    file_path: file,
    line_number: 1,
    code_snippet: null,
    description: "",
    fix_suggestion: "",
  };
}

function result(issues: ReturnType<typeof finding>[], tokens = {}): AIAnalysisResult {
  return { issues, summary: "", tokens_in: 0, tokens_out: 0, ...tokens };
}

function vulnerable(expect_: Fixture["expect"]): Fixture {
  return { id: "case", name: "case", diff: "diff", expect: expect_ };
}

const CLEAN: Fixture = { id: "clean", name: "clean", diff: "diff", expect: [] };

beforeEach(() => mockAnalyze.mockReset());

describe("runCase scoring", () => {
  it("credits a hit only when category and file both match", async () => {
    mockAnalyze.mockResolvedValue(result([finding("sql_injection", "b/api/users.ts")]));

    const hit = await runCase(vulnerable([{ file: "api/users.ts", categories: ["sql_injection"] }]));
    expect(hit.detected).toBe(1);
    expect(hit.extras).toBe(0);

    // Right category, wrong file — this is the miscount that would silently
    // inflate recall on a fixture set where one category appears twice.
    mockAnalyze.mockResolvedValue(result([finding("sql_injection", "b/api/orders.ts")]));
    const miss = await runCase(vulnerable([{ file: "api/users.ts", categories: ["sql_injection"] }]));
    expect(miss.detected).toBe(0);
    expect(miss.misses).toEqual(["sql_injection in api/users.ts"]);
    expect(miss.extras).toBe(1);
  });

  it("strips diff a/ b/ prefixes before comparing paths", async () => {
    mockAnalyze.mockResolvedValue(result([finding("xss", "a/src/render.ts")]));
    const c = await runCase(vulnerable([{ file: "src/render.ts", categories: ["xss"] }]));
    expect(c.detected).toBe(1);
  });

  it("accepts any listed category as a hit", async () => {
    mockAnalyze.mockResolvedValue(result([finding("nosql_injection", "db.ts")]));
    const c = await runCase(
      vulnerable([{ file: "db.ts", categories: ["sql_injection", "nosql_injection"] }]),
    );
    expect(c.detected).toBe(1);
  });

  it("counts every finding on a clean fixture as an extra", async () => {
    mockAnalyze.mockResolvedValue(
      result([finding("xss", "a.ts"), finding("idor", "b.ts")]),
    );
    const c = await runCase(CLEAN);
    expect(c.isClean).toBe(true);
    expect(c.expected).toBe(0);
    expect(c.extras).toBe(2);
  });

  it("records a scan error without throwing, and counts its expectations as missed", async () => {
    mockAnalyze.mockRejectedValue(new Error("provider 503"));

    const c = await runCase(vulnerable([{ file: "api/users.ts", categories: ["idor"] }]));
    expect(c.error).toBe("provider 503");
    expect(c.detected).toBe(0);
    // The denominator must keep the expectation. Dropping it would let an
    // outage raise recall, which is the wrong direction for a CI gate.
    expect(c.expected).toBe(1);
    expect(c.misses).toEqual(["idor in api/users.ts"]);
  });

  it("carries cached tokens through so cache hit rate is measurable", async () => {
    mockAnalyze.mockResolvedValue(
      result([], { tokens_in: 1000, tokens_out: 50, cached_tokens: 800 }),
    );
    const c = await runCase(CLEAN);
    expect(c.tokensIn).toBe(1000);
    expect(c.cachedTokens).toBe(800);
  });

  it("treats a provider that omits cached tokens as zero, not undefined", async () => {
    mockAnalyze.mockResolvedValue(result([], { tokens_in: 500, tokens_out: 10 }));
    const c = await runCase(CLEAN);
    expect(c.cachedTokens).toBe(0);
  });
});
