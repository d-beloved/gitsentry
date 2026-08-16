# Scanner eval harness

A fixed benchmark of diffs with known planted vulnerabilities (and known-clean
changes) so scanner changes are **measured**, not guessed at. Run it before and
after any prompt, model, or pipeline change.

```bash
yarn eval                      # full pipeline: scan + verifier + secrets detector
VERIFY_FINDINGS=off yarn eval  # A/B the verification pass
```

Needs the backend env (`apps/backend/.env` with `AI_API_KEY` + model vars).
No database or GitHub access required.

## Metrics

- **recall** — expected vulnerabilities detected / expected total
- **clean-fixture FPs** — findings on known-clean fixtures (target: 0)
- **extras** — unexpected findings on vulnerable fixtures (informational; often
  legitimate secondary findings)

Optional gates for CI: `EVAL_MIN_RECALL=0.8 EVAL_MAX_CLEAN_FPS=0 yarn eval`
exits non-zero when breached.

## Adding fixtures

Drop a `<case>.diff` + `<case>.expected.json` pair into `eval/fixtures/`:

```json
{
  "name": "What this case covers",
  "expect": [
    { "file": "src/routes/orders.js", "categories": ["sql_injection"] }
  ]
}
```

`categories` is an any-of list (e.g. `["missing_auth", "privilege_escalation"]`
when either is a fair call). An empty `expect` array marks a clean fixture —
any finding on it counts as a false positive.

Good sources of new fixtures: real findings your team confirmed, and real
false positives your team dismissed (add those as clean fixtures so the
scanner never repeats them).
