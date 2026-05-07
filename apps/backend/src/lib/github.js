const { App } = require("@octokit/app");
const { sortBySeverity, countBySeverity } = require("./scorer");

// Lazy-initialise so tests can run without env vars
let _app;
function getApp() {
  if (!_app) {
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY
      ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY, "base64").toString("utf8")
      : "";

    _app = new App({
      appId: process.env.GITHUB_APP_ID,
      privateKey,
    });
  }
  return _app;
}

async function getOctokit(installationId) {
  return getApp().getInstallationOctokit(installationId);
}

// ─── GitHub API calls ─────────────────────────────────────────────────────────

/**
 * Fetch the diff for a pull request.
 */
async function getDiff(repoFullName, prNumber, installationId) {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber,
    headers: { accept: "application/vnd.github.v3.diff" },
  });

  return response.data;
}

/**
 * Fetch the diff for a single commit.
 */
async function getPushDiff(repoFullName, commitSha, installationId) {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const response = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
    owner,
    repo,
    ref: commitSha,
    headers: { accept: "application/vnd.github.v3.diff" },
  });

  return response.data;
}

/**
 * Post a PR review comment with all findings.
 */
async function postPRReview(repoFullName, prNumber, issues, summary, scanId, installationId) {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const body = formatReviewBody(issues, summary, scanId);

  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

/**
 * Post a comment on a commit with all findings.
 */
async function postCommitComment(repoFullName, commitSha, issues, summary, scanId, installationId) {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const body = formatReviewBody(issues, summary, scanId);

  await octokit.request("POST /repos/{owner}/{repo}/commits/{commit_sha}/comments", {
    owner,
    repo,
    commit_sha: commitSha,
    body,
  });
}

// ─── Comment formatter ────────────────────────────────────────────────────────

const SEVERITY_EMOJI = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" };
const PRODUCT_NAME = "Gitsentry.dev";
const PRODUCT_URL = "https://gitsentry.dev";

const CATEGORY_LABELS = {
  hardcoded_secret: "Hardcoded Secret",
  missing_auth: "Missing Authentication",
  sql_injection: "SQL Injection",
  idor: "Insecure Direct Object Reference (IDOR)",
  verbose_error: "Verbose Error Exposure",
  unvalidated_input: "Unvalidated Input",
  missing_rate_limit: "Missing Rate Limit",
  insecure_deserialization: "Insecure Deserialization",
  path_traversal: "Path Traversal",
  xss: "Cross-Site Scripting (XSS)",
  open_redirect: "Open Redirect",
  csrf: "Cross-Site Request Forgery (CSRF)",
  weak_session_management: "Weak Session Management",
  privilege_escalation: "Privilege Escalation",
  insecure_password_reset: "Insecure Password Reset",
  token_leakage: "Token Leakage",
  command_injection: "Command Injection",
  nosql_injection: "NoSQL Injection",
  template_injection: "Template Injection",
  ssrf: "Server-Side Request Forgery (SSRF)",
  insecure_file_upload: "Insecure File Upload",
  sensitive_data_exposure: "Sensitive Data Exposure",
  crypto_misuse: "Cryptography Misuse",
  insecure_storage: "Insecure Storage",
  mass_assignment: "Mass Assignment",
  business_logic_abuse: "Business Logic Abuse",
  race_condition: "Race Condition",
  replay_attack: "Replay Attack",
  timing_attack: "Timing Attack",
  cache_poisoning: "Cache Poisoning",
  cors_misconfiguration: "CORS Misconfiguration",
  security_headers_missing: "Missing Security Headers",
  debug_exposure: "Debug or Admin Exposure",
  cloud_misconfiguration: "Cloud or Storage Misconfiguration",
  dependency_risk: "Dependency or Supply Chain Risk",
  attack_chain: "Attack Chain",
  other: "Other",
};

function findingReportUrl(findingId) {
  return `${PRODUCT_URL}/dashboard/findings/${findingId}`;
}

function findingDismissUrl(findingId) {
  return `${PRODUCT_URL}/api/findings/${findingId}/dismiss`;
}

function formatReviewBody(issues, summary, scanId) {
  const sorted = sortBySeverity(issues);
  const counts = countBySeverity(issues);

  const countParts = ["critical", "high", "medium", "low"]
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`);

  let body = `## 🔐 ${PRODUCT_NAME} Security Scan\n\n`;
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

    if (issue.id) {
      body += `[View full report](${findingReportUrl(issue.id)}) · `;
      body += `[False positive?](${findingDismissUrl(issue.id)})\n\n`;
    }

    body += `---\n\n`;
  }

  body += `> ${summary}\n\n`;
  body += `_Powered by [${PRODUCT_NAME}](${PRODUCT_URL})`;
  if (scanId) body += ` · scan ${scanId}`;
  body += `_`;

  return body;
}

module.exports = { getDiff, getPushDiff, postPRReview, postCommitComment };
