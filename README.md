# GitSentry

> AI-powered security scanner that watches every Git event: PRs, branch pushes, and direct commits to main, and catches vulnerabilities in your code before they reach production.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub App](https://img.shields.io/badge/GitHub-App-black?logo=github)](https://github.com/apps/gitsentry)

---

## The Problem

Engineering teams ship code using AI tools (Cursor, Copilot, Claude Code, etc.) faster than they review it. AI models produce predictable security anti-patterns: missing auth checks, unvalidated inputs, hardcoded secrets, IDOR vulnerabilities. Existing scanners aren't trained on these specific failure modes.

## The Solution

GitSentry installs as a GitHub App. It listens to every `pull_request` and `push` event; PRs, feature branches, and direct pushes to main. On each event it runs an AI security analysis and surfaces findings exactly where developers already work: **as GitHub PR review comments and commit comments**.

```
PR opened → webhook → AI analysis → GitHub review comment posted
```

## Install

[![Install GitSentry](https://img.shields.io/badge/Install-GitHub%20App-2ea44f?logo=github)](https://github.com/apps/gitsentry)

One click. No config required.

The dashboard at [gitsentry.dev](https://gitsentry.dev) is hosted and proprietary. **The analysis engine powering it is fully open source** (this repo).

---

## What It Catches

| Category             | Example                                           |
| -------------------- | ------------------------------------------------- |
| `hardcoded_secret`   | API keys, tokens, passwords in source code        |
| `missing_auth`       | New routes with no authentication middleware      |
| `sql_injection`      | User input concatenated into SQL queries          |
| `idor`               | User-supplied IDs fetched without ownership check |
| `verbose_error`      | Stack traces / DB errors exposed to client        |
| `unvalidated_input`  | User input passed to dangerous operations         |
| `missing_rate_limit` | Auth endpoints with no rate limiting              |
| `path_traversal`     | User input in file system operations              |
| `xss`                | Unsanitised user content in HTML responses        |
| `open_redirect`      | User-controlled redirect URLs                     |

---

## Self-Hosting

### Prerequisites

- Node.js 20+
- A GitHub App (see setup below)
- Supabase project
- Redis (for job queue)
- Google Gemini API key

### 1. Create a GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set the webhook URL to `https://your-domain.com/webhook`
3. Generate a webhook secret and a private key
4. Grant these permissions:
   - **Repository → Pull requests**: Read & write
   - **Repository → Contents**: Read
   - **Repository → Commit statuses**: Read & write
5. Subscribe to events: `Pull request`, `Push`

### 2. Configure environment

```bash
cd apps/backend
cp .env.example .env
# Fill in your values
```

### 3. Run the database migrations

Run the SQL in `apps/backend/src/db/schema.sql` against your Supabase project.

### 4. Start the server

```bash
yarn install
yarn run dev:backend
```

### 5. Expose locally for testing

```bash
npx smee -u https://smee.io/your-channel -t http://localhost:3000/webhook
```

---

## Repository Structure

```
apps/
  backend/          ← Node.js webhook server + AI engine (this repo, MIT)
packages/
  shared/           ← Shared TypeScript types and constants (this repo, MIT)
```

The dashboard at [gitsentry.dev](https://gitsentry.dev) is hosted and proprietary. The analysis engine powering it is fully open source.

---

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT — see [LICENSE](LICENSE).
