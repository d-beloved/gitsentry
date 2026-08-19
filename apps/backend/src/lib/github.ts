import {App} from "@octokit/app";
import {sortBySeverity, countBySeverity} from "./scorer";
import {
  SEVERITY_EMOJI,
  CATEGORY_LABELS,
} from "../../../../packages/scanner-contract/constants";
import type {Finding, ScanCoverage} from "../../../../packages/scanner-contract/types";

let _app: App | undefined;

function getApp(): App {
  if (!_app) {
    const appId = process.env.GITHUB_APP_ID;
    const encodedKey = process.env.GITHUB_APP_PRIVATE_KEY;

    if (!appId || !encodedKey) {
      throw new Error(
        "Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY environment variables.",
      );
    }

    const privateKey = Buffer.from(encodedKey, "base64").toString("utf8");
    _app = new App({appId, privateKey});
  }
  return _app;
}

export async function getInstallationOctokit(installationId: number) {
  return getApp().getInstallationOctokit(installationId);
}

// Keep the internal alias so existing callers in this file are unchanged
const getOctokit = getInstallationOctokit;

// ─── GitHub API calls ─────────────────────────────────────────────────────────

export async function getDiff(
  repoFullName: string,
  prNumber: number,
  installationId: number,
): Promise<string> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner,
      repo,
      pull_number: prNumber,
      headers: {accept: "application/vnd.github.v3.diff"},
    },
  );

  return response.data as unknown as string;
}

export async function getIncrementalDiff(
  repoFullName: string,
  baseSha: string,
  headSha: string,
  installationId: number,
): Promise<string> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/compare/{basehead}",
    {
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
      headers: {accept: "application/vnd.github.v3.diff"},
    },
  );

  return response.data as unknown as string;
}

export async function getPushDiff(
  repoFullName: string,
  commitSha: string,
  installationId: number,
): Promise<string> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/commits/{ref}",
    {
      owner,
      repo,
      ref: commitSha,
      headers: {accept: "application/vnd.github.v3.diff"},
    },
  );

  return response.data as unknown as string;
}

export async function postPRReview(
  repoFullName: string,
  prNumber: number,
  issues: Finding[],
  /** Required, not defaulted: a caller that forgets this silently reverts to
   * overwriting a findings comment with an all-clear. Pass [] to say so. */
  carried: Finding[],
  summary: string,
  scanId: string,
  installationId: number,
  existingCommentId?: number | null,
  coverage?: ScanCoverage,
): Promise<number> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const body = formatReviewBody(issues, carried, summary, scanId, !!existingCommentId, coverage);

  if (existingCommentId) {
    const {data} = await octokit.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {owner, repo, comment_id: existingCommentId, body},
    );
    return data.id;
  }

  const {data} = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {owner, repo, issue_number: prNumber, body},
  );
  return data.id;
}

export async function postCommitComment(
  repoFullName: string,
  commitSha: string,
  issues: Finding[],
  summary: string,
  scanId: string,
  installationId: number,
): Promise<void> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  // Nothing carried: a push scan posts a fresh comment per commit rather than
  // editing an earlier one, so it can never overwrite a prior result.
  const body = formatReviewBody(issues, [], summary, scanId);

  await octokit.request(
    "POST /repos/{owner}/{repo}/commits/{commit_sha}/comments",
    {
      owner,
      repo,
      commit_sha: commitSha,
      body,
    },
  );
}

// ─── Comment formatter ────────────────────────────────────────────────────────

const PRODUCT_NAME = "Gitsentry.dev";
const PRODUCT_URL = process.env.PRODUCT_URL;

function formatFooter(summary: string, scanId: string, isUpdate: boolean): string {
  let footer = `> ${summary}\n\n`;
  footer += `💬 Comment \`/gitsentry rescan\` on this PR to re-run the scan at any time.\n\n`;
  footer += `_Powered by [${PRODUCT_NAME}](${PRODUCT_URL})`;
  if (scanId) footer += ` · scan \`${scanId.slice(0, 8)}\``;
  if (isUpdate) footer += ` · updated ${new Date().toUTCString()}`;
  footer += `_`;
  return footer;
}

function formatCoverageNote(coverage?: ScanCoverage): string {
  if (!coverage?.truncated) return "";
  if (coverage.filesScanned < coverage.filesTotal) {
    return `> ⚠️ **Partial scan** — this PR exceeded the diff size budget. Scanned ${coverage.filesScanned} of ${coverage.filesTotal} changed files (docs/style files are dropped first).\n\n`;
  }
  return `> ⚠️ Large PR — surrounding context lines were reduced to fit the diff size budget. All ${coverage.filesTotal} changed files were scanned.\n\n`;
}

function formatIssue(issue: Finding): string {
  const emoji = SEVERITY_EMOJI[issue.severity] || "⚪";
  const label = CATEGORY_LABELS[issue.category] || issue.category;

  let out = `### ${emoji} ${issue.severity.toUpperCase()} — ${label}\n`;
  out += `**File:** \`${issue.file_path}\``;
  if (issue.line_number) out += ` · **Line:** ${issue.line_number}`;
  out += "\n\n";

  if (issue.code_snippet) {
    const ext = issue.file_path.split(".").pop() || "";
    out += `\`\`\`${ext}\n${issue.code_snippet}\n\`\`\`\n\n`;
  }

  out += `**Issue:** ${issue.description}\n\n`;
  out += `**Fix:** ${issue.fix_suggestion}\n\n`;
  out += `---\n\n`;
  return out;
}

/**
 * @param issues  findings raised by the scan that just ran
 * @param carried findings from earlier scans of this PR that are still open and
 *                that this scan did not re-read (its diff never touched their
 *                file). They are reprinted so updating the comment in place can
 *                never downgrade a PR to "clean" on the strength of a scan that
 *                only saw an unrelated slice of it.
 */
export function formatReviewBody(
  issues: Finding[],
  carried: Finding[],
  summary: string,
  scanId: string,
  isUpdate = false,
  coverage?: ScanCoverage,
): string {
  let body = `## 🔐 ${PRODUCT_NAME} Security Scan\n\n`;

  if (issues.length === 0 && carried.length === 0) {
    body += formatCoverageNote(coverage);
    body += `**No security issues found** in this PR. ✅\n\n`;
    body += formatFooter(summary, scanId, isUpdate);
    return body;
  }
  body += formatCoverageNote(coverage);

  const total = issues.length + carried.length;
  const counts = countBySeverity([...issues, ...carried]);

  const countParts = (["critical", "high", "medium", "low"] as const)
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`);

  body += `Found **${total} issue${total !== 1 ? "s" : ""}** in this PR`;
  if (countParts.length) body += ` (${countParts.join(", ")})`;
  body += `\n\n---\n\n`;

  // Only label the sections when there is something to tell apart — a first
  // scan, or any scan that saw the whole PR, still reads exactly as before.
  if (issues.length && carried.length) {
    body += `#### Introduced by the latest commits\n\n`;
  }
  for (const issue of sortBySeverity(issues)) body += formatIssue(issue);

  if (carried.length) {
    body += `#### Still open from earlier commits\n\n`;
    body += issues.length === 0
      ? `> The latest commits are clean, but these issues from earlier in the PR have not been addressed. This scan did not re-read the files they live in, so they stand until a commit touches that code.\n\n`
      : `> Raised by an earlier scan of this PR and not yet addressed. Line numbers are from the commit that raised them and may have shifted.\n\n`;
    for (const issue of sortBySeverity(carried)) body += formatIssue(issue);
  }

  body += formatFooter(summary, scanId, isUpdate);
  return body;
}

export async function getSweepDiff(
  repoFullName: string,
  branch: string,
  installationId: number,
): Promise<string> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const {data: commits} = await octokit.request(
    "GET /repos/{owner}/{repo}/commits",
    {
      owner,
      repo,
      sha: branch,
      per_page: 6,
    },
  );

  if (!commits.length) return "";

  if (commits.length === 1) {
    return getPushDiff(repoFullName, commits[0].sha, installationId);
  }

  const head = commits[0].sha;
  const base = commits[Math.min(commits.length - 1, 5)].sha;

  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/compare/{basehead}",
    {
      owner,
      repo,
      basehead: `${base}...${head}`,
      headers: {accept: "application/vnd.github.v3.diff"},
    },
  );

  return response.data as unknown as string;
}

/**
 * Post a GitHub Check Run after a PR scan.
 *
 * Free plan: conclusion is always "neutral" — findings are visible but PRs are never blocked.
 * Pro plan: conclusion is "failure" when findings exist, enabling branch protection.
 */
export async function postCheckRun(
  repoFullName: string,
  headSha: string,
  findings: Finding[],
  /** Still-open findings from earlier scans of this PR — see postPRReview. The
   * gate has to count them, or a follow-up commit touching an unrelated file
   * turns the check green while the issue is still in the branch. Required for
   * the same reason: forgetting it must not quietly pass the PR. */
  carried: Finding[],
  installationId: number,
): Promise<void> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const total = findings.length + carried.length;

  let conclusion: string;
  let title: string;
  let summary: string;

  if (total === 0) {
    conclusion = "success";
    title = "No security issues found";
    summary = "Gitsentry.dev scanned this PR and found no security issues.";
  } else {
    conclusion = "failure";
    title = `${total} security issue${total !== 1 ? "s" : ""} found`;
    summary =
      "Gitsentry.dev found some security issues. Resolve the issues before merging.\n\n" +
      "To dismiss a false positive, visit your [Gitsentry dashboard](" +
      PRODUCT_URL +
      "/dashboard).";
  }

  await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: "Gitsentry Security Scan",
    head_sha: headSha,
    status: "completed",
    conclusion,
    output: {title, summary},
  });
}

// Subscription states that mean a paid plan has lapsed. Paddle sets plan:"free"
// on lapse, so the status is the only thing that still says "this org used to
// pay us" — and their repos may still carry the branch protection we set up
// while they did. See hasRequiredCheck.
const LAPSED_SUBSCRIPTION_STATUSES = new Set(["canceled", "past_due", "payment_failed"]);

/**
 * Whether "Gitsentry Security Scan" is a required status check on this org's
 * repos — i.e. whether a PR we never report on gets stuck on "Expected —
 * waiting for status to be reported" and blocks the merge forever.
 *
 * setupBranchProtection only ever runs for Pro, so Pro is the main case. Lapsed
 * orgs are here as a safety net: the Paddle webhook does call
 * removeBranchProtectionForOrg on downgrade, but that is best-effort — it walks
 * the org's repos under Promise.allSettled, only covers rows with an
 * installation_id, only touches default_branch, and logs failures rather than
 * retrying them. Any repo it misses keeps a required check we have stopped
 * feeding, which strands every later PR. Admitting lapsed orgs here costs a
 * redundant neutral check where the removal worked, and unblocks the PRs where
 * it did not.
 *
 * Everyone else has no protection, and posting a check run for them would create
 * one where none existed. That is why this gate is here and not just an isPro
 * check at each call site.
 */
export function hasRequiredCheck(
  org: {plan?: string | null; subscription_status?: string | null} | null,
): boolean {
  if (!org) return false;
  const status = org.subscription_status;
  if (org.plan === "pro" && (status === "active" || status == null)) return true;
  return !!status && LAPSED_SUBSCRIPTION_STATUSES.has(status);
}

/**
 * Why a PR was not scanned. Every one of these is a state we decided on
 * deliberately — the diff had nothing in it, the plan doesn't cover this scan —
 * as opposed to a scan that ran and failed, which is postIncompleteCheckRun.
 */
export type SkippedScanReason =
  | "no_scannable_changes"
  | "dependency_bot"
  | "release_automation"
  | "quota_exceeded"
  | "subscription_inactive"
  | "no_org";

const SKIP_COPY: Record<SkippedScanReason, {title: string; summary: string}> = {
  no_scannable_changes: {
    title: "No scannable changes",
    summary:
      "This PR changes no application code — the diff is empty, or contains only " +
      "lockfiles and generated output. There was nothing for Gitsentry.dev to scan.",
  },
  dependency_bot: {
    title: "Dependency update — not scanned",
    summary:
      "Gitsentry.dev does not scan dependency-update PRs: they change lockfiles and " +
      "manifests rather than application code. Review the upstream changelog as usual.",
  },
  release_automation: {
    title: "Release automation — not scanned",
    summary:
      "This PR was opened by release automation and only bumps versions and " +
      "changelogs, so Gitsentry.dev did not scan it.",
  },
  quota_exceeded: {
    title: "Monthly scan limit reached",
    summary: "",
  },
  subscription_inactive: {
    title: "Scanning paused — subscription inactive",
    summary:
      "Your subscription has ended, so this PR was **not scanned for security issues**. " +
      `Reactivate it from your [Gitsentry dashboard](${PRODUCT_URL}/dashboard) to resume scanning.`,
  },
  no_org: {
    title: "Not scanned — installation incomplete",
    summary:
      "Gitsentry.dev has no organisation record for this repository, so this PR was " +
      "**not scanned for security issues**. Reinstall the app, or contact support, to " +
      "finish setting it up.",
  },
};

/**
 * Report a PR we deliberately did not scan, so the required check resolves.
 *
 * The conclusion is "neutral", which satisfies a required status check and lets
 * the PR merge. That is a deliberate choice, and it is not the same call as
 * postIncompleteCheckRun: there, we tried to establish the PR's security state
 * and could not, so the gate holds. Here we either know there was nothing to
 * check, or we chose not to check for reasons of billing — and blocking a
 * customer's merges over their invoice turns a billing conversation into an
 * outage on their repo. It also gets the required check deleted, which loses us
 * the gate permanently on the very account we wanted to convert.
 *
 * The check still carries the reason in its summary, and the billing cases post
 * a PR comment alongside it — a grey check nobody expands is disclosure, not
 * notification.
 */
export async function postSkippedCheckRun(
  repoFullName: string,
  headSha: string,
  installationId: number,
  reason: SkippedScanReason,
  /** Only for "quota_exceeded", which names the plan and its limit. */
  quota?: {plan: string; limit: number},
): Promise<void> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  // Idempotency. Several of the call sites never write a scan row, so their own
  // duplicate-delivery guards (which key off the scans table) cannot see a
  // repeat — a redelivered webhook would stack a second identical grey check on
  // the same commit. Reporting the same conclusion twice is harmless to the
  // gate but looks like a malfunction in the PR. On a lookup failure we post
  // anyway: a duplicate check is a cosmetic problem, an unreported one blocks
  // the merge.
  try {
    const {data} = await octokit.request(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      {owner, repo, ref: headSha, check_name: CHECK_NAME},
    );
    if (data.check_runs.some((run) => run.status === "completed")) {
      return;
    }
  } catch (err) {
    console.warn(
      `[github] check-run lookup failed for ${repoFullName}@${headSha.slice(0, 7)} — posting anyway:`,
      (err as Error).message,
    );
  }

  const copy = SKIP_COPY[reason];
  const summary =
    reason === "quota_exceeded"
      ? `This PR was **not scanned for security issues**: the ${
          PLAN_LABELS[quota?.plan ?? "free"] ?? "Free"
        } plan includes ${quota?.limit ?? 10} scans per month and this month's are used up.\n\n` +
        `Scanning resumes next month, or immediately on a higher plan — see your ` +
        `[Gitsentry dashboard](${PRODUCT_URL}/dashboard).`
      : copy.summary;

  await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion: "neutral",
    output: {title: copy.title, summary},
  });
}

/**
 * Close out the check run for a scan that never produced a result.
 *
 * Pro repos have "Gitsentry Security Scan" as a required status check, and the
 * only check run we ever post is the completed one at the end of a successful
 * scan. So a scan that dies — the worker killed mid-run, the queued job dropped
 * — leaves the PR sitting on "Expected — waiting for status to be reported"
 * with no way for the author to clear it. The reaper closes the row out in the
 * database; this closes it out on the PR.
 *
 * "timed_out" rather than "neutral" on purpose: a required security gate must
 * not open itself because our own pipeline failed. It renders as a red check
 * whose Re-run button is wired to handleCheckRun, so the author's fix is one
 * click.
 */
export async function postIncompleteCheckRun(
  repoFullName: string,
  headSha: string,
  installationId: number,
  /** Whether the scan's credit was handed back, so the summary can say so. */
  creditRefunded: boolean,
): Promise<void> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion: "timed_out",
    output: {
      title: "Scan did not complete",
      summary:
        "Gitsentry.dev started scanning this commit but the scan never finished, " +
        "so this PR has not been checked for security issues.\n\n" +
        (creditRefunded ? "The scan credit has been refunded to your account.\n\n" : "") +
        "Click **Re-run** on this check to scan the PR again, or start a rescan from your " +
        `[Gitsentry dashboard](${PRODUCT_URL}/dashboard).`,
    },
  });
}

// ─── Branch protection ────────────────────────────────────────────────────────

const CHECK_NAME = "Gitsentry Security Scan";

/**
 * Ensures the "Gitsentry Security Scan" required status check is present on the
 * repo's default branch. If branch protection doesn't exist yet, creates minimal
 * protection (no PR review requirement, no push restrictions, admins not enforced).
 * If protection already exists, non-destructively adds our check to the existing
 * required_status_checks list.
 */
export async function setupBranchProtection(
  repoFullName: string,
  branch: string,
  installationId: number,
): Promise<void> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  let hasExistingProtection = false;
  let existingContexts: string[] = [];

  try {
    const {data} = await octokit.request(
      "GET /repos/{owner}/{repo}/branches/{branch}/protection",
      {owner, repo, branch},
    );
    hasExistingProtection = true;
    existingContexts = data.required_status_checks?.contexts ?? [];
  } catch {
    // 404 = no protection yet — handled below
  }

  if (hasExistingProtection) {
    if (existingContexts.includes(CHECK_NAME)) return; // already set up
    await octokit.request(
      "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
      {owner, repo, branch, contexts: [CHECK_NAME]},
    );
  } else {
    await octokit.request(
      "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
      {
        owner,
        repo,
        branch,
        required_status_checks: {strict: false, contexts: [CHECK_NAME]},
        enforce_admins: false,
        required_pull_request_reviews: null,
        restrictions: null,
      },
    );
  }
}

export async function postSyncSkipComment(
  repoFullName: string,
  prNumber: number,
  linesAdded: number,
  installationId: number,
  existingCommentId?: number | null,
): Promise<number> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const lineWord = linesAdded === 1 ? "line" : "lines";
  const body = [
    `## 🔐 ${PRODUCT_NAME} — Update Skipped`,
    "",
    `Last scan found **no issues** ✅ · this push added only **${linesAdded} ${lineWord}** of new code. Re-scan skipped to protect your monthly quota.`,
    "",
    `Comment \`/gitsentry rescan\` to scan this update manually.`,
    "",
    `_Powered by [${PRODUCT_NAME}](${PRODUCT_URL})_`,
  ].join("\n");

  if (existingCommentId) {
    const {data} = await octokit.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {owner, repo, comment_id: existingCommentId, body},
    );
    return data.id;
  }

  const {data} = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {owner, repo, issue_number: prNumber, body},
  );
  return data.id;
}

export async function postBotPRSkipComment(
  repoFullName: string,
  prNumber: number,
  botLogin: string,
  installationId: number,
): Promise<void> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const body = [
    `## 🔐 ${PRODUCT_NAME} Security Scan`,
    "",
    `This PR was opened by **@${botLogin}** (a bot). To protect your monthly scan quota, automatic scanning is paused for bot-authored PRs on this plan.`,
    "",
    `Comment \`/gitsentry scan\` on this PR to run a security scan manually.`,
    "",
    `_Powered by [${PRODUCT_NAME}](${PRODUCT_URL})_`,
  ].join("\n");

  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {owner, repo, issue_number: prNumber, body},
  );
}

// ─── Project classifier support ───────────────────────────────────────────────

// Source code and documentation extensions to exclude when scanning for manifests.
// Everything else at the root level that is small is likely a manifest of some kind.
const SOURCE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "java", "kt", "scala", "cs", "fs", "vb",
  "cpp", "cc", "c", "h", "hpp", "rs", "swift", "m",
  "php", "lua", "ex", "exs", "erl", "hs", "ml", "r", "dart",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "md", "txt", "rst", "adoc", "html", "css", "scss", "svg", "png",
  "jpg", "jpeg", "gif", "ico", "woff", "woff2", "ttf", "eot",
  "lock", "sum", "log",
]);

const DOC_NAME_RE = /^(readme|license|licence|changelog|contributing|authors|notice|patents|codeowners|security)/i;

function looksLikeManifest(path: string): boolean {
  if (path.includes("/")) return false; // root-level only
  if (DOC_NAME_RE.test(path)) return false;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (SOURCE_EXTS.has(ext)) return false;
  return true;
}

/**
 * Scans the root tree for any file that looks like a project manifest
 * (non-source, non-doc root-level file) and returns its content.
 * Works across any language — no hardcoded list of filenames needed.
 */
export async function fetchRepoManifestFiles(
  repoFullName: string,
  branch: string,
  installationId: number,
): Promise<string | null> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  // Fetch root tree (non-recursive — manifests are at root)
  let rootFiles: Array<{path?: string; type?: string; size?: number; sha?: string}> = [];
  try {
    const {data: tree} = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{ref}",
      {owner, repo, ref: branch},
    );
    rootFiles = (tree.tree ?? []).filter(
      (f: {path?: string; type?: string; size?: number}) =>
        f.type === "blob" &&
        typeof f.path === "string" &&
        looksLikeManifest(f.path) &&
        (f.size ?? 0) < 50_000,
    );
  } catch {
    return null;
  }

  if (!rootFiles.length) return null;

  // Fetch all candidate manifests in parallel and concatenate (up to 5, 3KB each)
  const results = await Promise.all(
    rootFiles.slice(0, 5).map(async (f) => {
      try {
        const {data} = await octokit.request(
          "GET /repos/{owner}/{repo}/contents/{path}",
          {owner, repo, path: f.path!, ref: branch},
        );
        if (data && "content" in data && typeof data.content === "string") {
          const content = Buffer.from(data.content, "base64").toString("utf8");
          return `=== ${f.path} ===\n${content.slice(0, 3_000)}`;
        }
      } catch { /* skip */ }
      return null;
    }),
  );

  const combined = results.filter(Boolean).join("\n\n");
  return combined || null;

  return null;
}

// ─── Security context discovery ───────────────────────────────────────────────

const MAX_FILE_BYTES = 4_000;
const MAX_AUTH_FILES = 10;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|py|rb|go|java|php|cs|rs|swift|kt)$/i;

/**
 * Returns true when a file path looks like it could contain authentication,
 * authorization, or session management logic. Works across frameworks and
 * naming conventions — no hardcoded path list required.
 * Exported so securityContext.ts can use the same rule for cache invalidation.
 */
export function isAuthRelevantPath(filePath: string): boolean {
  if (filePath === ".gitsentry/context.md") return true;
  const basename = filePath.split("/").pop() ?? "";
  if (!SOURCE_EXT.test(basename)) return false;

  // Exact high-signal names
  if (/^(auth|middleware|session|passport|guard|guards)\.(ts|tsx|js|jsx|py|rb|go|java|php|cs|rs|swift|kt)$/i.test(basename)) return true;

  // auth- prefixed or -auth suffixed variants (auth-config.ts, use-auth.ts, etc.)
  if (/^auth[-_.]/i.test(basename) || /[-_.]auth\./i.test(basename)) return true;

  // Compound names: auth-config, auth-helper, auth-service, auth-utils, auth-middleware, auth-guard, auth-provider
  if (/auth[-_](config|helper|utils|service|guard|middleware|provider|context|client)\./i.test(basename)) return true;

  // Route files inside an /auth/ directory — catches NextAuth.js/Auth.js route handlers
  if (/^route\.(ts|js|tsx|jsx)$/i.test(basename) && /\/auth\//i.test(filePath)) return true;

  // NextAuth.js catch-all route pattern: [...nextauth].ts or [...nextauth]/route.ts
  if (/\[\.\.\.nextauth\]/i.test(filePath)) return true;

  return false;
}

/**
 * Discovers authentication and middleware files by walking the repo's git tree,
 * then fetches their content. Works regardless of the project's naming conventions
 * or framework — no hardcoded path list required.
 */
export async function fetchRepoAuthFiles(
  repoFullName: string,
  branch: string,
  installationId: number,
): Promise<{path: string; content: string}[]> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  let pathsToFetch: string[];

  try {
    const { data: commit } = await octokit.request(
      "GET /repos/{owner}/{repo}/commits/{ref}",
      { owner, repo, ref: branch },
    );
    const treeSha = (commit.commit as { tree: { sha: string } }).tree.sha;

    const { data: tree } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner, repo, tree_sha: treeSha, recursive: "1" },
    );

    const items = (tree.tree as Array<{ path?: string; type?: string }>) ?? [];
    pathsToFetch = items
      .filter((item) => item.type === "blob" && item.path && isAuthRelevantPath(item.path))
      .map((item) => item.path as string)
      .sort((a, b) => a.split("/").length - b.split("/").length) // shallower paths first
      .slice(0, MAX_AUTH_FILES);
  } catch (err) {
    console.warn("[github] fetchRepoAuthFiles tree walk failed:", (err as Error).message);
    return [];
  }

  if (pathsToFetch.length === 0) return [];

  const results = await Promise.allSettled(
    pathsToFetch.map(async (path) => {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner, repo, path, ref: branch },
      );
      if (data && "content" in data && typeof data.content === "string") {
        const content = Buffer.from(data.content, "base64").toString("utf8");
        return { path, content: content.slice(0, MAX_FILE_BYTES) };
      }
      return null;
    }),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<{ path: string; content: string }> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value);
}

/**
 * Removes the "Gitsentry Security Scan" required status check from the repo's
 * default branch. Swallows 404s — if branch protection doesn't exist (e.g.
 * user deleted it manually), there's nothing to remove.
 */
export async function removeBranchProtection(
  repoFullName: string,
  branch: string,
  installationId: number,
): Promise<void> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  try {
    await octokit.request(
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
      {owner, repo, branch, contexts: [CHECK_NAME]},
    );
  } catch (err) {
    if ((err as {status?: number}).status !== 404) throw err;
  }
}

const PLAN_LABELS: Record<string, string> = {free: "Free", starter: "Starter", pro: "Pro"};

/**
 * Posts (or updates, if existingCommentId is given) the quota-exceeded comment.
 * Returns the PR comment's id so callers can persist it and update the same
 * comment on the next quota-exceeded push, instead of stacking a new one each
 * time. commitSha-only targets aren't updatable (each commit is a distinct
 * event) so no id is returned for that branch.
 */
export async function postUpgradeComment(
  repoFullName: string,
  target: {prNumber?: number | null; commitSha?: string | null},
  installationId: number,
  plan: string = "free",
  scanLimit: number = 10,
  existingCommentId?: number | null,
): Promise<number | null> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const planLabel = PLAN_LABELS[plan] ?? "Free";
  const upgradeLine =
    plan === "pro"
      ? `Your **${scanLimit} scans** for this month have all been used. Need a higher cap? [Contact us](${PRODUCT_URL}/dashboard/billing) about a custom plan.`
      : `**[Upgrade](${PRODUCT_URL}/dashboard/billing)** for more monthly scans, private repo support, and on-demand security sweeps.`;

  const body = [
    `## 🔐 ${PRODUCT_NAME} — ${planLabel} Plan Limit Reached`,
    "",
    `You've used all **${scanLimit} scans** for this month on the ${planLabel} plan. This commit was not scanned.`,
    "",
    upgradeLine,
    "",
    `_Powered by [${PRODUCT_NAME}](${PRODUCT_URL})_`,
  ].join("\n");

  if (target.prNumber != null) {
    if (existingCommentId) {
      const {data} = await octokit.request(
        "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
        {owner, repo, comment_id: existingCommentId, body},
      );
      return data.id;
    }
    const {data} = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: target.prNumber,
        body,
      },
    );
    return data.id;
  } else if (target.commitSha) {
    await octokit.request(
      "POST /repos/{owner}/{repo}/commits/{commit_sha}/comments",
      {
        owner,
        repo,
        commit_sha: target.commitSha,
        body,
      },
    );
  }
  return null;
}

/**
 * Posts a PR comment explaining that scanning is paused because the org's
 * subscription ended (so private-repo scanning is disabled). Mirrors
 * postUpgradeComment — used when a downgraded org opens a PR on a private repo,
 * so the reason for "no scan" is visible on the PR, not just silently dropped.
 */
export async function postSubscriptionPausedComment(
  repoFullName: string,
  prNumber: number,
  installationId: number,
  existingCommentId?: number | null,
): Promise<number> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const body = [
    `## ⏸️ ${PRODUCT_NAME} — Scanning Paused`,
    "",
    "Your subscription has ended, so **private-repo scanning is currently disabled** — this PR was not scanned. Public repositories are still scanned on the free plan.",
    "",
    `**[Resubscribe](${PRODUCT_URL}/dashboard/billing)** to re-enable private-repo scans, security sweeps, and PR check runs.`,
    "",
    `_Powered by [${PRODUCT_NAME}](${PRODUCT_URL})_`,
  ].join("\n");

  if (existingCommentId) {
    const {data} = await octokit.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {owner, repo, comment_id: existingCommentId, body},
    );
    return data.id;
  }

  const {data} = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {owner, repo, issue_number: prNumber, body},
  );
  return data.id;
}
