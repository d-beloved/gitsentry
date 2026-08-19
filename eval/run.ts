/**
 * Scanner eval CLI — measures detection quality against a fixed benchmark so
 * prompt/model/pipeline changes can be compared instead of guessed at.
 *
 * Usage:
 *   yarn eval                       # full pipeline (scan + verifier + secrets detector)
 *   VERIFY_FINDINGS=off yarn eval   # A/B the verifier's effect
 *
 * Requires the same env as the backend (AI_API_KEY + model vars); no database
 * or GitHub access is needed. The scoring itself lives in harness.ts, shared
 * with the admin-triggered run so both report the same numbers.
 *
 * Reported metrics:
 *   recall     — expected vulnerabilities detected / expected total
 *   clean FPs  — findings reported on clean fixtures (should be 0)
 *   extras     — unexpected findings on vulnerable fixtures (informational)
 */
import { loadFixtures, runEval, type EvalCaseResult } from "./harness";

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One line per fixture, printed as it finishes — the sweep takes minutes. */
function printCase(c: EvalCaseResult): void {
  if (c.error) {
    console.log(`✗ ${c.fixtureId} — ERROR (${c.error})`);
    return;
  }
  if (c.isClean) {
    if (c.extras === 0) {
      console.log(`✓ ${c.fixtureId} — clean, no findings (${secs(c.durationMs)})`);
    } else {
      const detail = c.findings.map((f) => `${f.category}@${f.file}`).join(", ");
      console.log(`✗ ${c.fixtureId} — ${c.extras} FALSE POSITIVE(S): ${detail} (${secs(c.durationMs)})`);
    }
    return;
  }
  const status = c.detected === c.expected ? "✓" : "✗";
  console.log(
    `${status} ${c.fixtureId} — ${c.detected}/${c.expected} expected found, ${c.extras} extra (${secs(c.durationMs)})`,
  );
}

/** Reconstructs the failure lines from the scored cases. */
function failuresFor(c: EvalCaseResult): string[] {
  if (c.error) return [`${c.fixtureId}: scan errored — ${c.error}`];
  if (c.isClean) {
    if (c.extras === 0) return [];
    return [
      `${c.fixtureId}: ${c.extras} false positive(s): ${c.findings.map((f) => f.category).join(", ")}`,
    ];
  }
  const got = c.findings.map((f) => f.category).join(", ") || "nothing";
  return c.misses.map((m) => `${c.fixtureId}: MISSED ${m} (got: ${got})`);
}

async function main() {
  const total = loadFixtures().length;
  console.log(
    `Running eval on ${total} fixtures (verifier: ${process.env.VERIFY_FINDINGS === "off" ? "OFF" : "on"})\n`,
  );

  const run = await runEval((c) => printCase(c));
  const failures = run.cases.flatMap(failuresFor);

  console.log("\n──────── results ────────");
  const recallPct = run.expectedTotal ? ((run.detected / run.expectedTotal) * 100).toFixed(0) : "–";
  console.log(`recall:            ${run.detected}/${run.expectedTotal} (${recallPct}%)`);
  console.log(`clean-fixture FPs: ${run.cleanFPs}`);
  console.log(`extra findings:    ${run.extras} (informational)`);
  if (run.cachedTokens > 0) {
    const hitRate = ((run.cachedTokens / run.tokensIn) * 100).toFixed(0);
    console.log(`prompt cache:      ${run.cachedTokens}/${run.tokensIn} in-tokens cached (${hitRate}%)`);
  }
  console.log(`tokens:            ${run.tokensIn} in / ${run.tokensOut} out, ${secs(run.durationMs)} total`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }

  // Non-zero exit when quality regresses hard, so this can gate CI later.
  // Errored fixtures count their expectations as misses rather than dropping
  // out of the denominator — an outage that silently raised recall would be
  // exactly the wrong signal for a gate.
  const recallOk =
    run.expectedTotal === 0 ||
    run.detected / run.expectedTotal >= Number(process.env.EVAL_MIN_RECALL ?? 0);
  const fpOk = run.cleanFPs <= Number(process.env.EVAL_MAX_CLEAN_FPS ?? Infinity);
  process.exit(recallOk && fpOk ? 0 : 1);
}

main();
