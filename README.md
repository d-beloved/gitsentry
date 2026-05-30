# Gitsentry.dev

> AI-powered security scanner for pull requests. Catches vulnerabilities introduced by AI coding tools (Cursor, Copilot, Claude Code) before they reach production.

**[MIT License](LICENSE)** · **[Install on GitHub →](https://github.com/apps/gitsentry-dev)**

![Gitsentry.dev in action](assets/demo.gif)

---

## What it does

Gitsentry.dev installs as a GitHub App. When a PR is opened or updated it runs an AI security analysis on the diff and posts findings as GitHub review comments — right where your team already works.

```
PR opened / updated  →  webhook  →  AI analysis  →  GitHub review comment
```

On Pro, a GitHub Check Run is posted with `failure` when critical or high severity findings exist. Wire it to branch protection and merges are blocked until findings are resolved or dismissed.

**The analysis engine and webhook server are fully open source (MIT).** The hosted dashboard at [gitsentry.dev](https://gitsentry.dev) is proprietary — same model as Sentry or PostHog. You can self-host the entire stack using this repo.

---

## Install

**[Install Gitsentry.dev on GitHub →](https://github.com/apps/gitsentry-dev)**

One click. No config files required to get started.

---

## What it catches

| Category                                             | Example                                           |
| ---------------------------------------------------- | ------------------------------------------------- |
| `hardcoded_secret`                                   | API keys, tokens, passwords in source code        |
| `missing_auth`                                       | New routes with no authentication middleware      |
| `sql_injection`                                      | User input concatenated into SQL queries          |
| `idor`                                               | User-supplied IDs fetched without ownership check |
| `verbose_error`                                      | Stack traces / DB errors exposed to client        |
| `unvalidated_input`                                  | User input passed to dangerous operations         |
| `missing_rate_limit`                                 | Auth endpoints with no rate limiting              |
| `path_traversal`                                     | User input in file system operations              |
| `xss`                                                | Unsanitised user content in HTML responses        |
| `open_redirect`                                      | User-controlled redirect URLs                     |
| `csrf` / `weak_session_management`                   | Browser and session flow weaknesses               |
| `privilege_escalation` / `mass_assignment`           | Permission and object mutation abuse              |
| `race_condition` / `business_logic_abuse`            | Workflow and state manipulation bugs              |
| `cors_misconfiguration` / `security_headers_missing` | Deployment and browser boundary risks             |
| `dependency_risk`                                    | Vulnerable or suspicious dependency behaviour     |
| `attack_chain`                                       | Multiple smaller issues combined into one exploit |

The prompt is tuned specifically for patterns produced by AI coding assistants — not generic SAST rules.

---

## Rescan a PR

Post `/gitsentry rescan` as a comment on any open PR to trigger a fresh scan on the current HEAD commit. Only repo collaborators, members, and owners can trigger rescans. The existing Gitsentry comment is updated in place rather than a new one being posted.

---

## Blocking merges on findings (Pro)

Gitsentry posts a **GitHub Check Run** named `Gitsentry Security Scan` after every PR scan on Pro. The conclusion is `failure` when critical or high severity findings are present; `success` when the diff is clean.

Pro orgs also get **automatic branch protection setup**: after the first scan on a repo, Gitsentry non-destructively adds `Gitsentry Security Scan` to the repo's required status checks. No manual GitHub settings needed.

To set it up manually:

1. Go to your repo → **Settings → Branches**
2. Edit (or create) the protection rule for your default branch
3. Enable **"Require status checks to pass before merging"**
4. Add **`Gitsentry Security Scan`** as a required check

> The check name appears in the search only after Gitsentry has run at least one scan on a PR in that repository.

Free and Starter plans receive no check run — findings are visible as PR comments but merges are never blocked. Upgrade to Pro to enable blocking.

---

## Self-Hosting

### Prerequisites

- Node.js 20+
- A GitHub App (see setup below)
- Supabase project
- Google Gemini API key
- Redis (optional — falls back to inline processing without it)

### 1. Create a GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set the webhook URL to `https://your-domain.com/webhook`
3. Generate a webhook secret and a private key
4. Grant these permissions:
   - **Repository → Pull requests**: Read & write
   - **Repository → Contents**: Read
   - **Repository → Checks**: Read & write (required for check runs and merge blocking)
   - **Repository → Administration**: Read & write (required for auto branch protection setup)
5. Subscribe to events: `Pull request`, `Issue comment`

### 2. Configure environment

```bash
cp apps/backend/.env.example apps/backend/.env
# Fill in your values
```

```bash
# apps/backend/.env

GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=           # base64-encoded PEM
GITHUB_WEBHOOK_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

GEMINI_API_KEY=
# ANTHROPIC_API_KEY=              # uncomment when switching to Claude

SUPABASE_URL=
SUPABASE_SECRET_KEY=

REDIS_URL=                        # optional — redis://localhost:6379

INTERNAL_API_KEY=                 # shared secret with dashboard; generate: openssl rand -hex 32
PRODUCT_URL=                      # e.g. https://gitsentry.dev

PORT=3000
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3001   # comma-separated in prod

RESEND_API_KEY=                   # optional — Resend email alerts
FROM_EMAIL=                       # optional — e.g. Gitsentry.dev <alerts@gitsentry.dev>
```

### 3. Run the database schema

Run the SQL in `apps/backend/src/db/schema.sql` against your Supabase project.

### 4. Start the server

```bash
yarn install
yarn dev
```

### 5. Expose locally for testing

```bash
npx smee -u https://smee.io/your-channel -t http://localhost:3000/webhook
```

---

## Repository Structure

This repo is the **open-source scanner only**. Source lives under `apps/backend/`; `packages/scanner-contract/` defines the public finding types and constants.

```
apps/backend/src/
  webhooks/        ← webhook router + event handlers
  lib/
    ai.ts          ← AI abstraction layer (Gemini; swap to Claude in one function)
    github.ts      ← Octokit wrapper
    differ.ts      ← diff parser and additions extractor
    scorer.ts      ← severity scoring
    notifier.ts    ← Slack + email alerts
    queue.ts       ← Bull queue + dispatchScan helper
    workers/
      scanWorker.ts  ← core scan processor
  api/
    sweep.ts       ← POST /api/sweep (on-demand security sweep)
    rescan.ts      ← POST /api/rescan (dashboard-triggered rescan)
  db/              ← Supabase client, queries, types

packages/scanner-contract/
  types.ts         ← Finding, AIAnalysisResult, ScanContext, ScanJobData
  constants.ts     ← SEVERITY_ORDER, SEVERITY_EMOJI, CATEGORY_LABELS
```

The dashboard at [gitsentry.dev](https://gitsentry.dev) is hosted and proprietary. The analysis engine powering it is fully open source.

---

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT — see [LICENSE](LICENSE).
