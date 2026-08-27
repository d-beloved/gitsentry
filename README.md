# Gitsentry.dev

> AI-powered security scanner for pull requests. Catches vulnerabilities introduced by AI coding tools (Cursor, Copilot, Claude Code) before they reach production.

**[MIT License](LICENSE)** · **[Install on GitHub →](https://github.com/apps/gitsentry-dev)**

![Gitsentry.dev in action](https://github.com/user-attachments/assets/e70f0423-c1a7-4624-87c3-ffe4d3966fea)

---

## What it does

Gitsentry.dev installs as a GitHub App. Open or update a pull request and it reads the diff, runs a security analysis across 37 vulnerability categories, and posts the results where your team already works.

```
PR opened / updated
  → webhook
  → project classification + repo security context
  → diff scan
  → deterministic secret rules merged in
  → verification pass drops findings it cannot prove
  → PR comment (plus a check run on Pro)
```

One comment per PR. Push again and Gitsentry edits that comment in place instead of stacking a new one under it.

The scan reads added lines, removed lines, and the surrounding unchanged context. A PR that deletes an auth check, an ownership guard, a sanitiser, or a rate limit gets flagged under the category of the control it removed, not just PRs that add something dangerous.

**The analysis engine and webhook server are open source under MIT.** The hosted dashboard at [gitsentry.dev](https://gitsentry.dev) is proprietary, the same split Sentry and PostHog use. You can self-host the whole scanner from this repo.

---

## Install

**[Install Gitsentry.dev on GitHub →](https://github.com/apps/gitsentry-dev)**

One click. No config files needed to start.

---

## What it catches

37 categories, all available to both PR scans and security sweeps. The scanner drops the ones that cannot apply to your project type before it ever sees your code, so a static frontend never gets asked about SQL injection.

| Group                       | Categories                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Injection and taint**     | `sql_injection` `nosql_injection` `command_injection` `template_injection` `prompt_injection` `ssrf` `path_traversal` `xss` `open_redirect` `unvalidated_input` |
| **Access control**          | `missing_auth` `idor` `privilege_escalation` `mass_assignment` `insecure_password_reset` `weak_session_management` `csrf`            |
| **Secrets and exposure**    | `hardcoded_secret` `token_leakage` `sensitive_data_exposure` `insecure_storage` `verbose_error` `crypto_misuse`                      |
| **Logic and timing**        | `business_logic_abuse` `race_condition` `replay_attack` `timing_attack` `cache_poisoning` `missing_rate_limit`                       |
| **Platform and supply chain** | `cors_misconfiguration` `security_headers_missing` `debug_exposure` `cloud_misconfiguration` `dependency_risk` `insecure_file_upload` `insecure_deserialization` |
| **Composite**               | `attack_chain`                                                                                                                      |

`prompt_injection` matters more every month: AI assistants write LLM call sites faster than anyone reviews them, and user input reaching a prompt without trust-boundary delimiters is now as common as string-concatenated SQL was in 2010.

The prompt targets patterns AI coding assistants produce. It is not a port of generic SAST rules.

---

## Keeping false positives down

A scanner nobody trusts gets muted in a week, so four layers sit between a model's guess and your PR.

**Taint tracking, not pattern matching.** Every finding has to name the untrusted source, the dangerous sink, the missing control, and the exploit path. "This function doesn't check ownership" gets rejected. "This route is reachable without an ownership check" gets reported.

**A verification pass.** A second call re-reads the same diff with one job: prove each candidate finding against the code it claims to describe. Rejected findings never reach your PR, and uncertain ones survive with their confidence lowered. This pass fails open, so a timeout returns the original findings rather than losing a real one. Disable it with `VERIFY_FINDINGS=off` while you measure its effect.

**Deterministic secret rules.** AWS keys, GitHub tokens, Stripe live keys, and private key blocks match on format. Pattern matching does this perfectly, for free, without hallucinating, so those findings skip the verifier and outrank the model when both flag the same line.

**Project classification.** Before the scan, Gitsentry works out what it is looking at (API service, static frontend, CLI, library) and applies per-type rules that skip categories that cannot apply and demand stronger evidence for the ones that rarely do.

Dismiss a finding as a false positive twice in the same repo and Gitsentry learns. The category stays in scope, but it needs concrete evidence of an exploitable path before it will flag that category in that repo again.

---

## Improving scan accuracy with `.gitsentry/context.md`

Gitsentry discovers your repo's auth patterns and tech stack on the first scan by walking the git tree and reading dependency manifests. Most projects need nothing beyond that. It refreshes when a diff touches auth-relevant files, and otherwise every 90 days (`DISCOVERY_CACHE_TTL_DAYS`).

Three things cannot be inferred from code:

- **Cloud-hosted auth.** Clerk, Auth0, Firebase Auth, Supabase Auth, AWS Cognito, Okta. Your code calls their SDK; the logic lives in their cloud.
- **Infrastructure controls.** Auth or rate limiting enforced by an API gateway, reverse proxy, or sidecar that is not in this repo.
- **Narrowed input fields.** A parameter typed `string` that only ever receives values from a fixed internal enum, which taint analysis has no way to know.

Declare them in `.gitsentry/context.md` at the root of your repo:

```md
## Authentication

Auth is handled by Clerk via @clerk/nextjs. Every route under /app is protected by
Clerk's middleware. No local session management exists in this codebase.

## Rate limiting

Rate limiting is enforced at the AWS API Gateway layer, not in this service.

## Trust boundaries

This service is internal-only, always invoked by our orchestration layer which
validates JWTs before forwarding requests. Direct public access is not possible.

## Input constraints

The `action` field in webhook payloads only ever contains values from a fixed internal
enum defined by our event bus. It is never free-form user input.
```

The scanner extracts factual claims from this file and ignores any instructions embedded in it. Declared facts are authoritative for controls that live outside the codebase. They never suppress a finding where the diff itself bypasses or contradicts the declared control, such as a public route reading the trusted header directly instead of relying on the gateway.

---

## Rescan a PR

Comment `/gitsentry rescan` on any open PR to scan the current HEAD commit again. Repo collaborators, members, and owners can trigger it; nobody else can. Gitsentry updates its existing comment rather than posting a second one.

The dashboard's rescan button does the same thing through `POST /api/rescan`.

---

## Security sweeps

A PR scan reads one diff in isolation. A sweep reads your recent history on the default branch: `POST /api/sweep` compares the last six commits and reviews them as one body of work.

The sweep prompt is adversarial rather than line-by-line. It defines attacker profiles, entry points, trust boundaries, and sensitive assets, then looks for chained attack paths and business logic flaws that span commits, which is exactly what a per-PR scan cannot see. It returns a threat model and named attack chains alongside the findings.

Sweeps run on `AI_SWEEP_MODEL`, which should be your strongest model, and this is the one role where reasoning earns its cost (`AI_SWEEP_EXTRA_BODY`). Run one after a large refactor or before a launch. A sweep that fails before producing results refunds the slot it claimed.

The endpoint needs `INTERNAL_API_KEY`. On the hosted dashboard, the sweep button on any repo calls it for you.

---

## Blocking merges on findings (Pro)

Gitsentry posts a GitHub Check Run named `Gitsentry Security Scan` after every PR scan on Pro. The conclusion is `failure` when critical or high severity findings exist and `success` when the diff is clean.

Pro orgs also get branch protection set up for them: after the first scan on a repo, Gitsentry adds `Gitsentry Security Scan` to the required status checks without touching the rest of the rule.

To wire it up by hand:

1. Go to your repo → **Settings → Branches**
2. Edit or create the protection rule for your default branch
3. Enable **Require status checks to pass before merging**
4. Add **`Gitsentry Security Scan`** as a required check

> The check name only appears in GitHub's search after Gitsentry has run at least one scan on a PR in that repository.

Free and Starter plans get no check run. Findings show up as PR comments and merges are never blocked.

---

## Self-hosting

### Prerequisites

- Node.js 20+
- A GitHub App (see below)
- A Supabase project
- An API key for your AI provider (any Gemini-compatible or OpenAI-compatible endpoint)
- Redis, optional. Without it, scans process inline.

### 1. Create a GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set the webhook URL to `https://your-domain.com/webhook`
3. Generate a webhook secret and a private key
4. Grant these repository permissions:
   - **Pull requests**: Read & write (diffs, comments, and the `/gitsentry rescan` command)
   - **Contents**: Read (auth files, manifests, `.gitsentry/context.md`)
   - **Checks**: Read & write (check runs and merge blocking)
   - **Administration**: Read & write (automatic branch protection setup)
5. Subscribe to these events:

   | Event                        | What breaks without it                          |
   | ---------------------------- | ----------------------------------------------- |
   | `pull_request`               | Nothing scans                                   |
   | `issue_comment`              | `/gitsentry rescan` does nothing                |
   | `check_run`                  | GitHub's "re-run" button on a failed check dies |
   | `installation`               | Installs and uninstalls never register          |
   | `installation_repositories`  | Adding or removing repos never registers        |
   | `repository`                 | Renames and deletions leave stale rows          |
   | `github_app_authorization`   | OAuth revocation is not recorded                |

### 2. Configure environment

```bash
cp apps/backend/.env.example apps/backend/.env
```

The required set:

```bash
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=      # base64-encoded PEM
GITHUB_WEBHOOK_SECRET=

AI_API_KEY=
AI_SCAN_MODEL=               # PR diff scans
AI_SWEEP_MODEL=              # security sweeps, your strongest model
AI_DISCOVERY_MODEL=          # classification and context discovery, a cheap tier is enough

SUPABASE_URL=
SUPABASE_SECRET_KEY=

INTERNAL_API_KEY=            # shared secret with the dashboard: openssl rand -hex 32
PORT=3200
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3201   # comma-separated in prod
```

Everything else is optional and documented inline in [`apps/backend/.env.example`](apps/backend/.env.example), which is the reference for:

- **Provider routing**: `AI_BASE_URL`, `AI_STRUCTURED_MODE`, `AI_PROVIDER_ORDER`, `AI_ALLOW_FALLBACKS`
- **Reasoning and host knobs**: `AI_EXTRA_BODY` plus the per-role `AI_SCAN_EXTRA_BODY`, `AI_SWEEP_EXTRA_BODY`, `AI_DISCOVERY_EXTRA_BODY`, `AI_VERIFY_EXTRA_BODY`. Thinking is the biggest single lever on scan duration, and each role needs a different amount of it.
- **Verification**: `AI_VERIFIER_MODEL`, `VERIFY_FINDINGS`
- **Timeouts**: `AI_SCAN_TIMEOUT_MS`, `AI_DISCOVERY_TIMEOUT_MS`, `AI_VERIFY_TIMEOUT_MS`
- **Queue and reaper**: `REDIS_URL`, `SCAN_WORKER_CONCURRENCY`, `SCAN_REAPER`, `SCAN_QUEUE_TIMEOUT_MINUTES`, `SCAN_STRAND_TIMEOUT_MINUTES`
- **Alerts**: `RESEND_API_KEY`, `FROM_EMAIL`, `PRODUCT_URL`
- **Discovery cache**: `DISCOVERY_CACHE_TTL_DAYS`

GitHub OAuth credentials belong to the dashboard, not to this server. Nothing here reads them.

### 3. Run the database schema

Run the SQL in `apps/backend/src/db/schema.sql` against your Supabase project.

### 4. Start the server

```bash
yarn install
yarn dev
```

### 5. Expose locally for testing

```bash
npx smee -u https://smee.io/your-channel -t http://localhost:3200/webhook
```

---

## Measuring scanner changes

`eval/` holds fixtures with known vulnerabilities and known-clean code. Run the harness before and after any prompt change:

```bash
yarn eval
```

It reports recall on the vulnerable fixtures and false positives on the clean ones. Judge a prompt change on both numbers. A prompt that finds more bugs and cries wolf twice as often is a worse prompt.

---

## Repository structure

This repo is the open-source scanner. The backend lives under `apps/backend/`; the shared packages define the public contract and the provider layer.

```
apps/backend/src/
  webhooks/           ← router + handlers (pull_request, issue_comment, check_run,
                        installation, installation_repositories, repository,
                        github_app_authorization)
  lib/
    ai.ts             ← prompts, category set, scan and sweep calls
    verifier.ts       ← verification (judge) pass
    secretsDetector.ts← deterministic credential rules
    securityContext.ts← repo discovery, .gitsentry/context.md, learned dismissals
    aiEnv.ts          ← AI_* env resolution
    aiDeadline.ts     ← per-call wall-clock budgets
    github.ts         ← Octokit wrapper
    differ.ts         ← diff parsing, added and removed line extraction
    scorer.ts         ← severity scoring
    botDetection.ts   ← release and dependency bot PR skipping
    quotaPeriod.ts    ← which billing period usage counters belong to
    reaper.ts         ← closes out scans stranded in 'pending'
    queue.ts          ← Bull queue + dispatchScan
    notifier.ts       ← Slack and email alerts
    workers/
      scanWorker.ts   ← core scan processor
  api/
    sweep.ts          ← POST /api/sweep
    rescan.ts         ← POST /api/rescan
    eval.ts           ← POST /api/eval (admin, runs the eval harness)
  db/                 ← Supabase client, queries, types, schema.sql

packages/scanner-contract/
  types.ts            ← Finding, AIAnalysisResult, ScanContext, ScanJobData
  constants.ts        ← SEVERITY_ORDER, SEVERITY_EMOJI, CATEGORY_LABELS
  classifier.ts       ← classification prompt and response parsing
  scanner-rules.ts    ← per-project-type skip and deprioritise rules

packages/ai-provider/
  index.ts            ← provider selection from AI_* env
  gemini.ts           ← Google Generative AI
  openaiCompat.ts     ← any OpenAI-compatible endpoint
  schema.ts           ← structured-output schema helpers

eval/                 ← fixtures and harness for scanner changes
```

The dashboard at [gitsentry.dev](https://gitsentry.dev) is hosted and proprietary. The engine behind it is this repo.

---

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT. See [LICENSE](LICENSE).
