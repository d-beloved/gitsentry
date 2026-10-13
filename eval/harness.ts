// Eval engine shared by `yarn eval` and /admin/eval so both score identically.
// Fixtures: <case>.diff + <case>.expected.json; an empty "expect" marks a clean fixture.
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { analyzeCode } from "../apps/backend/src/lib/ai";

export interface Expectation {
  file: string;
  /** Any one of these counts as a hit. */
  categories: string[];
}

export interface Fixture {
  id: string;
  name: string;
  diff: string;
  expect: Expectation[];
}

export interface EvalFinding {
  category: string;
  file: string;
  severity: string;
}

export interface EvalCaseResult {
  fixtureId: string;
  fixtureName: string;
  /** Clean fixtures invert the scoring: any finding is a false positive. */
  isClean: boolean;
  expected: number;
  detected: number;
  /** Unmatched findings: informational on vulnerable fixtures, false positives on clean ones. */
  extras: number;
  durationMs: number;
  error: string | null;
  findings: EvalFinding[];
  misses: string[];
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
}

export interface EvalRunResult {
  cases: EvalCaseResult[];
  expectedTotal: number;
  detected: number;
  cleanFPs: number;
  extras: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  durationMs: number;
}

// `tsc` never copies fixtures into dist/, so try source-relative candidates too.
function resolveFixturesDir(): string {
  const candidates = [
    process.env.EVAL_FIXTURES_DIR,
    join(__dirname, "fixtures"),
    join(process.cwd(), "eval", "fixtures"),
    join(__dirname, "..", "..", "eval", "fixtures"),
  ].filter((c): c is string => Boolean(c));

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(
    `eval fixtures not found — looked in: ${candidates.join(", ")}. ` +
      "Set EVAL_FIXTURES_DIR to the directory holding the .diff fixtures.",
  );
}

export function loadFixtures(): Fixture[] {
  const FIXTURES_DIR = resolveFixturesDir();
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".diff"));
  return files.map((f) => {
    const id = f.replace(/\.diff$/, "");
    const meta = JSON.parse(
      readFileSync(join(FIXTURES_DIR, `${id}.expected.json`), "utf8"),
    ) as { name: string; expect: Expectation[] };
    return {
      id,
      name: meta.name,
      diff: readFileSync(join(FIXTURES_DIR, f), "utf8"),
      expect: meta.expect,
    };
  });
}

/** Fixture paths are repo-relative; scanner output carries diff a/ b/ prefixes. */
function normPath(p: string): string {
  return p.replace(/^[ab]\//, "").replace(/^\.?\/+/, "").toLowerCase();
}

function matches(finding: { category: string; file_path: string }, exp: Expectation): boolean {
  return (
    normPath(finding.file_path).endsWith(normPath(exp.file)) &&
    exp.categories.includes(finding.category)
  );
}

function missLabel(exp: Expectation): string {
  return `${exp.categories.join("|")} in ${exp.file}`;
}

/** Records a scan error on the case rather than throwing, so one bad fixture can't abort the run. */
export async function runCase(fixture: Fixture): Promise<EvalCaseResult> {
  const started = Date.now();
  const base = {
    fixtureId: fixture.id,
    fixtureName: fixture.name,
    isClean: fixture.expect.length === 0,
    expected: fixture.expect.length,
  };

  try {
    const result = await analyzeCode(fixture.diff, {
      repo: `eval/${fixture.id}`,
      branch: "main",
      triggerType: "pull_request",
      author: "eval-harness",
    });
    const issues = result.issues ?? [];
    const misses = fixture.expect.filter((exp) => !issues.some((i) => matches(i, exp)));

    return {
      ...base,
      detected: fixture.expect.length - misses.length,
      extras: issues.filter((i) => !fixture.expect.some((exp) => matches(i, exp))).length,
      durationMs: Date.now() - started,
      error: null,
      findings: issues.map((i) => ({
        category: i.category,
        file: i.file_path,
        severity: i.severity,
      })),
      misses: misses.map(missLabel),
      tokensIn: result.tokens_in ?? 0,
      tokensOut: result.tokens_out ?? 0,
      cachedTokens: result.cached_tokens ?? 0,
    };
  } catch (err) {
    return {
      ...base,
      detected: 0,
      extras: 0,
      durationMs: Date.now() - started,
      error: (err as Error).message,
      findings: [],
      misses: fixture.expect.map(missLabel),
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
    };
  }
}

/** Sequential so concurrent scans don't contend for rate limits and distort timings. */
export async function runEval(
  onCase?: (result: EvalCaseResult, index: number, total: number) => void | Promise<void>,
): Promise<EvalRunResult> {
  const fixtures = loadFixtures();
  const started = Date.now();
  const cases: EvalCaseResult[] = [];

  for (let i = 0; i < fixtures.length; i++) {
    const result = await runCase(fixtures[i]);
    cases.push(result);
    if (onCase) await onCase(result, i, fixtures.length);
  }

  const sum = (pick: (c: EvalCaseResult) => number) => cases.reduce((n, c) => n + pick(c), 0);

  return {
    cases,
    expectedTotal: sum((c) => c.expected),
    detected: sum((c) => c.detected),
    cleanFPs: cases.filter((c) => c.isClean).reduce((n, c) => n + c.extras, 0),
    extras: cases.filter((c) => !c.isClean).reduce((n, c) => n + c.extras, 0),
    tokensIn: sum((c) => c.tokensIn),
    tokensOut: sum((c) => c.tokensOut),
    cachedTokens: sum((c) => c.cachedTokens),
    durationMs: Date.now() - started,
  };
}
