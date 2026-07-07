/**
 * Scanner eval harness — measures detection quality against a fixed benchmark
 * so prompt/model/pipeline changes can be compared instead of guessed at.
 *
 * Usage:
 *   yarn eval                 # full pipeline (scan + verifier + secrets detector)
 *   VERIFY_FINDINGS=off yarn eval   # A/B the verifier's effect
 *
 * Requires the same env as the backend (GEMINI_API_KEY + model vars); no
 * database or GitHub access is needed. Fixtures live in eval/fixtures as
 * <case>.diff + <case>.expected.json pairs:
 *   { "name": "...", "expect": [ { "file": "...", "categories": ["sql_injection", ...] } ] }
 * An empty "expect" array marks a clean fixture — any finding on it counts as
 * a false positive.
 *
 * Reported metrics:
 *   recall     — expected vulnerabilities detected / expected total
 *   clean FPs  — findings reported on clean fixtures (should be 0)
 *   extras     — unexpected findings on vulnerable fixtures (informational)
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { analyzeCode } from "../apps/backend/src/lib/ai";

interface Expectation {
  file: string;
  categories: string[]; // any one of these counts as a hit
}

interface Fixture {
  id: string;
  name: string;
  diff: string;
  expect: Expectation[];
}

const FIXTURES_DIR = join(__dirname, "fixtures");

function loadFixtures(): Fixture[] {
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

function normPath(p: string): string {
  return p.replace(/^[ab]\//, "").replace(/^\.?\/+/, "").toLowerCase();
}

async function main() {
  const fixtures = loadFixtures();
  console.log(`Running eval on ${fixtures.length} fixtures (verifier: ${process.env.VERIFY_FINDINGS === "off" ? "OFF" : "on"})\n`);

  let expectedTotal = 0;
  let detected = 0;
  let cleanFPs = 0;
  let extras = 0;
  const failures: string[] = [];

  for (const fixture of fixtures) {
    const started = Date.now();
    let issues: { category: string; file_path: string; severity: string }[] = [];
    try {
      const result = await analyzeCode(fixture.diff, {
        repo: `eval/${fixture.id}`,
        branch: "main",
        triggerType: "pull_request",
        author: "eval-harness",
      });
      issues = result.issues;
    } catch (err) {
      failures.push(`${fixture.id}: scan errored — ${(err as Error).message}`);
      console.log(`✗ ${fixture.id} — ERROR (${(err as Error).message})`);
      continue;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    if (fixture.expect.length === 0) {
      // Clean fixture — every finding is a false positive.
      if (issues.length === 0) {
        console.log(`✓ ${fixture.id} — clean, no findings (${secs}s)`);
      } else {
        cleanFPs += issues.length;
        failures.push(
          `${fixture.id}: ${issues.length} false positive(s): ${issues.map((i) => i.category).join(", ")}`,
        );
        console.log(`✗ ${fixture.id} — ${issues.length} FALSE POSITIVE(S): ${issues.map((i) => `${i.category}@${i.file_path}`).join(", ")} (${secs}s)`);
      }
      continue;
    }

    // Vulnerable fixture — check each expectation.
    let hits = 0;
    for (const exp of fixture.expect) {
      expectedTotal++;
      const hit = issues.some(
        (i) =>
          normPath(i.file_path).endsWith(normPath(exp.file)) &&
          exp.categories.includes(i.category),
      );
      if (hit) {
        detected++;
        hits++;
      } else {
        failures.push(
          `${fixture.id}: MISSED ${exp.categories.join("|")} in ${exp.file} (got: ${issues.map((i) => i.category).join(", ") || "nothing"})`,
        );
      }
    }
    const extraFindings = issues.filter(
      (i) =>
        !fixture.expect.some(
          (exp) =>
            normPath(i.file_path).endsWith(normPath(exp.file)) &&
            exp.categories.includes(i.category),
        ),
    );
    extras += extraFindings.length;

    const status = hits === fixture.expect.length ? "✓" : "✗";
    console.log(
      `${status} ${fixture.id} — ${hits}/${fixture.expect.length} expected found, ${extraFindings.length} extra (${secs}s)`,
    );
  }

  console.log("\n──────── results ────────");
  console.log(`recall:            ${detected}/${expectedTotal} (${expectedTotal ? ((detected / expectedTotal) * 100).toFixed(0) : "–"}%)`);
  console.log(`clean-fixture FPs: ${cleanFPs}`);
  console.log(`extra findings:    ${extras} (informational)`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }

  // Non-zero exit when quality regresses hard, so this can gate CI later.
  const recallOk = expectedTotal === 0 || detected / expectedTotal >= Number(process.env.EVAL_MIN_RECALL ?? 0);
  const fpOk = cleanFPs <= Number(process.env.EVAL_MAX_CLEAN_FPS ?? Infinity);
  process.exit(recallOk && fpOk ? 0 : 1);
}

main();
