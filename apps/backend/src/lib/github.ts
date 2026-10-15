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

const getOctokit = getInstallationOctokit;

// --- GitHub API calls ---

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
  /** Required so a forgetful caller can't overwrite findings with an all-clear. */
  carried: Finding[],
  summary: string,
  scanId: string,
  installationId: number,
  existingCommentId?: number | null,
  coverage?: ScanCoverage,
  /** duplicate_of id → where that issue is already listed, e.g. "PR #12". */
  trackedIn?: Map<string, string>,
): Promise<number> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const body = formatReviewBody(issues, carried, summary, scanId, !!existingCommentId, coverage, trackedIn);

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

  // Nothing carried: push scans post a fresh comment per commit, never an edit.
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

// --- Comment formatter ---

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

/** Inline code that can't break out: branch names and model output may carry backticks or markup. */
export function codeSpan(text: string): string {
  return `\`${text.replace(/[`<>\r\n]/g, "")}\``;
}

// Issues already written up on another PR get one line each, folded away, instead of a full repeat.
function formatTrackedElsewhere(tracked: Array<{issue: Finding; where: string}>): string {
  const places = [...new Set(tracked.map((t) => t.where))];
  const n = tracked.length;
  let out = `<details>\n<summary>${n} issue${n !== 1 ? "s" : ""} already flagged in ${places.join(", ")}</summary>\n\n`;
  out += `> The same code is in this branch, so ${n !== 1 ? "they" : "it"} still count${n !== 1 ? "" : "s"} toward this PR's check. Resolving or dismissing on the dashboard clears every PR at once.\n\n`;
  for (const {issue, where} of sortBySeverity(tracked.map((t) => ({...t, severity: t.issue.severity})))) {
    const emoji = SEVERITY_EMOJI[issue.severity] || "⚪";
    const label = CATEGORY_LABELS[issue.category] || issue.category.replace(/[^\w -]/g, "");
    const loc = `${issue.file_path}${issue.line_number ? `:${issue.line_number}` : ""}`;
    out += `- ${emoji} **${issue.severity.toUpperCase()}** — ${label} in ${codeSpan(loc)} · see ${where}\n`;
  }
  out += `\n</details>\n\n`;
  return out;
}

/** `carried` are still-open earlier findings this scan didn't re-read; reprinted so an edit never reads as clean. */
export function formatReviewBody(
  allIssues: Finding[],
  allCarried: Finding[],
  summary: string,
  scanId: string,
  isUpdate = false,
  coverage?: ScanCoverage,
  trackedIn?: Map<string, string>,
): string {
  const whereTracked = (f: Finding) => (f.duplicate_of ? trackedIn?.get(f.duplicate_of) : undefined);
  const issues = allIssues.filter((f) => !whereTracked(f));
  const carried = allCarried.filter((f) => !whereTracked(f));
  const tracked = [...allIssues, ...allCarried]
    .filter((f) => whereTracked(f))
    .map((issue) => ({issue, where: whereTracked(issue)!}));

  let body = `## 🔐 ${PRODUCT_NAME} Security Scan\n\n`;

  if (issues.length === 0 && carried.length === 0) {
    body += formatCoverageNote(coverage);
    if (tracked.length) {
      body += `**No new security issues** in this PR.\n\n`;
      body += formatTrackedElsewhere(tracked);
    } else {
      body += `**No security issues found** in this PR. ✅\n\n`;
    }
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

  if (tracked.length) body += formatTrackedElsewhere(tracked);

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

export async function postCheckRun(
  repoFullName: string,
  headSha: string,
  findings: Finding[],
  /** Still-open earlier findings; the gate must count them or an unrelated commit turns it green. */
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

// Paddle sets plan:"free" on lapse, so status is the only sign the org's repos
// may still carry our branch protection.
const LAPSED_SUBSCRIPTION_STATUSES = new Set(["canceled", "past_due", "payment_failed"]);

/** Whether our check may be required (an unreported PR would block forever); lapsed orgs included since protection removal is best-effort. */
export function hasRequiredCheck(
  org: {plan?: string | null; subscription_status?: string | null} | null,
): boolean {
  if (!org) return false;
  const status = org.subscription_status;
  if (org.plan === "pro" && (status === "active" || status == null)) return true;
  return !!status && LAPSED_SUBSCRIPTION_STATUSES.has(status);
}

/** Deliberate skips only; a scan that ran and failed goes through postIncompleteCheckRun. */
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

/** Neutral (merge allowed) on purpose: a deliberate skip, unlike a failed scan, must not block merges over billing. */
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

  // Some callers write no scan row, so redeliveries are deduped here. On lookup
  // failure post anyway: a duplicate is cosmetic, a missing check blocks merge.
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

/** "timed_out", not "neutral": a security gate must not open because our pipeline failed; Re-run rescans. */
export async function postIncompleteCheckRun(
  repoFullName: string,
  headSha: string,
  installationId: number,
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

// --- Branch protection ---

const CHECK_NAME = "Gitsentry Security Scan";

/** Adds our required check without disturbing existing protection; creates minimal protection if none. */
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
    // 404 = no protection yet.
  }

  if (hasExistingProtection) {
    if (existingContexts.includes(CHECK_NAME)) return;
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

// --- Project classifier support ---

// Any small root-level file outside these extensions is treated as a manifest.
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
  if (path.includes("/")) return false;
  if (DOC_NAME_RE.test(path)) return false;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (SOURCE_EXTS.has(ext)) return false;
  return true;
}

export async function fetchRepoManifestFiles(
  repoFullName: string,
  branch: string,
  installationId: number,
): Promise<string | null> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

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

// --- Security context discovery ---

const MAX_FILE_BYTES = 4_000;
const MAX_AUTH_FILES = 10;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|py|rb|go|java|php|cs|rs|swift|kt)$/i;

/** Shared with securityContext.ts so cache invalidation uses the same rule. */
export function isAuthRelevantPath(filePath: string): boolean {
  if (filePath === ".gitsentry/context.md") return true;
  const basename = filePath.split("/").pop() ?? "";
  if (!SOURCE_EXT.test(basename)) return false;

  if (/^(auth|middleware|session|passport|guard|guards)\.(ts|tsx|js|jsx|py|rb|go|java|php|cs|rs|swift|kt)$/i.test(basename)) return true;

  if (/^auth[-_.]/i.test(basename) || /[-_.]auth\./i.test(basename)) return true;

  if (/auth[-_](config|helper|utils|service|guard|middleware|provider|context|client)\./i.test(basename)) return true;

  // Route handlers under /auth/ (NextAuth.js/Auth.js).
  if (/^route\.(ts|js|tsx|jsx)$/i.test(basename) && /\/auth\//i.test(filePath)) return true;

  if (/\[\.\.\.nextauth\]/i.test(filePath)) return true;

  return false;
}

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
      .sort((a, b) => a.split("/").length - b.split("/").length)
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

/** Swallows 404: no protection means nothing to remove. */
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

/** Returns the PR comment id so the next push updates it instead of stacking; null for commit targets. */
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
