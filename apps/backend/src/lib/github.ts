import {App} from "@octokit/app";
import {sortBySeverity, countBySeverity} from "./scorer";
import {
  SEVERITY_EMOJI,
  CATEGORY_LABELS,
} from "../../../../packages/scanner-contract/constants";
import type {Finding} from "../../../../packages/scanner-contract/types";

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
  summary: string,
  scanId: string,
  installationId: number,
  existingCommentId?: number | null,
): Promise<number> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const body = formatReviewBody(issues, summary, scanId, !!existingCommentId);

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

  const body = formatReviewBody(issues, summary, scanId);

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

function formatReviewBody(
  issues: Finding[],
  summary: string,
  scanId: string,
  isUpdate = false,
): string {
  let body = `## 🔐 ${PRODUCT_NAME} Security Scan\n\n`;

  if (issues.length === 0) {
    body += `**No security issues found** in this PR. ✅\n\n`;
    body += formatFooter(summary, scanId, isUpdate);
    return body;
  }

  const sorted = sortBySeverity(issues);
  const counts = countBySeverity(issues);

  const countParts = (["critical", "high", "medium", "low"] as const)
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`);

  body += `Found **${issues.length} issue${issues.length !== 1 ? "s" : ""}** in this PR`;
  if (countParts.length) body += ` (${countParts.join(", ")})`;
  body += `\n\n---\n\n`;

  for (const issue of sorted) {
    const emoji = SEVERITY_EMOJI[issue.severity] || "⚪";
    const label = CATEGORY_LABELS[issue.category] || issue.category;

    body += `### ${emoji} ${issue.severity.toUpperCase()} — ${label}\n`;
    body += `**File:** \`${issue.file_path}\``;
    if (issue.line_number) body += ` · **Line:** ${issue.line_number}`;
    body += "\n\n";

    if (issue.code_snippet) {
      const ext = issue.file_path.split(".").pop() || "";
      body += `\`\`\`${ext}\n${issue.code_snippet}\n\`\`\`\n\n`;
    }

    body += `**Issue:** ${issue.description}\n\n`;
    body += `**Fix:** ${issue.fix_suggestion}\n\n`;

    body += `---\n\n`;
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
  installationId: number,
): Promise<void> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const total = findings.length;

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

export const AUTH_FILE_CANDIDATES = [
  ".gitsentry/context.md",
  "middleware.ts",
  "middleware.js",
  "src/middleware.ts",
  "lib/auth.ts",
  "lib/auth.js",
  "lib/auth/index.ts",
  "src/lib/auth.ts",
  "utils/auth.ts",
  "src/utils/auth.ts",
  "app/lib/auth.ts",
  "app/middleware.ts",
];

const MAX_FILE_BYTES = 4_000;

/**
 * Fetches key authentication/middleware files from a repo via the GitHub API.
 * Used to seed the per-repo security context on first scan.
 * Silently skips files that don't exist — most repos only have a subset.
 */
export async function fetchRepoAuthFiles(
  repoFullName: string,
  branch: string,
  installationId: number,
): Promise<{path: string; content: string}[]> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const results = await Promise.allSettled(
    AUTH_FILE_CANDIDATES.map(async (path) => {
      const {data} = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {owner, repo, path, ref: branch},
      );
      if (data && "content" in data && typeof data.content === "string") {
        const content = Buffer.from(data.content, "base64").toString("utf8");
        return {path, content: content.slice(0, MAX_FILE_BYTES)};
      }
      return null;
    }),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<{path: string; content: string}> =>
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

export async function postUpgradeComment(
  repoFullName: string,
  target: {prNumber?: number | null; commitSha?: string | null},
  installationId: number,
): Promise<void> {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const body = [
    `## 🔐 ${PRODUCT_NAME} — Free Tier Limit Reached`,
    "",
    "You've used all **10 free scans** for this month. This commit was not scanned.",
    "",
    `**[Upgrade to Pro](${PRODUCT_URL}/dashboard/billing)** for unlimited scans, private repo support, and on-demand security sweeps.`,
    "",
    `_Powered by [${PRODUCT_NAME}](${PRODUCT_URL})_`,
  ].join("\n");

  if (target.prNumber != null) {
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: target.prNumber,
        body,
      },
    );
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
}
