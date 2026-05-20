const {App} = require("@octokit/app");
const {sortBySeverity, countBySeverity} = require("./scorer");
const {
  SEVERITY_EMOJI,
  CATEGORY_LABELS,
  GITSENTRY_URL,
} = require("../../../../packages/scanner-contract/constants");

// Lazy-initialise so tests can run without env vars
let _app;
function getApp() {
  if (!_app) {
    const appId = process.env.GITHUB_APP_ID;
    const encodedKey = process.env.GITHUB_APP_PRIVATE_KEY;

    if (!appId || !encodedKey) {
      throw new Error(
        "Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY environment variables.",
      );
    }

    const privateKey = Buffer.from(encodedKey, "base64").toString("utf8");

    _app = new App({
      appId,
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

  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner,
      repo,
      pull_number: prNumber,
      headers: {accept: "application/vnd.github.v3.diff"},
    },
  );

  return response.data;
}

/**
 * Fetch the diff for a single commit.
 */
async function getPushDiff(repoFullName, commitSha, installationId) {
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

  return response.data;
}

/**
 * Post a PR review comment with all findings.
 */
async function postPRReview(
  repoFullName,
  prNumber,
  issues,
  summary,
  scanId,
  installationId,
) {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const body = formatReviewBody(issues, summary, scanId);

  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner,
      repo,
      issue_number: prNumber,
      body,
    },
  );
}

/**
 * Post a comment on a commit with all findings.
 */
async function postCommitComment(
  repoFullName,
  commitSha,
  issues,
  summary,
  scanId,
  installationId,
) {
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
const PRODUCT_URL = GITSENTRY_URL;

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

/**
 * Fetch a diff spanning the last 5 commits on a branch — used for security sweeps.
 */
async function getSweepDiff(repoFullName, branch, installationId) {
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

  // With only one commit there is no range to compare; just return that commit's diff
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

  return response.data;
}

/**
 * Post a GitHub Check Run after a PR scan.
 *
 * Free plan: conclusion is always "neutral" — findings are visible but PRs are never blocked.
 * Pro plan: conclusion is "failure" when critical or high findings exist, enabling branch protection.
 *
 * Users configure blocking by adding "Gitsentry Security Scan" as a required status check
 * in their repo's branch protection settings (Settings → Branches → Require status checks).
 */
async function postCheckRun(repoFullName, headSha, findings, installationId) {
  const octokit = await getOctokit(installationId);
  const [owner, repo] = repoFullName.split("/");

  const total = findings.length;
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  const blocking = criticalCount > 0 || highCount > 0;

  let conclusion, title, summary;

  if (total === 0) {
    conclusion = "success";
    title = "No security issues found";
    summary = "Gitsentry.dev scanned this PR and found no security issues.";
  } else if (blocking) {
    conclusion = "failure";
    const parts = [];
    if (criticalCount > 0) parts.push(`${criticalCount} critical`);
    if (highCount > 0) parts.push(`${highCount} high`);
    title = `${total} security issue${total !== 1 ? "s" : ""} found (${parts.join(", ")})`;
    summary =
      "Gitsentry.dev found blocking security issues. Resolve critical and high severity findings before merging.\n\n" +
      "To dismiss a false positive, visit your [Gitsentry dashboard](" + PRODUCT_URL + "/dashboard).";
  } else {
    conclusion = "neutral";
    title = `${total} low-severity finding${total !== 1 ? "s" : ""} — informational`;
    summary = `Gitsentry.dev found ${total} medium/low severity finding${total !== 1 ? "s" : ""}. These are informational and do not block merging.`;
  }

  await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: "Gitsentry Security Scan",
    head_sha: headSha,
    status: "completed",
    conclusion,
    output: { title, summary },
  });
}

/**
 * Post an upgrade-prompt comment when the free-tier scan limit is reached.
 * Handles both PR comments (prNumber set) and commit comments (commitSha set).
 */
async function postUpgradeComment(
  repoFullName,
  {prNumber, commitSha},
  installationId,
) {
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

  if (prNumber != null) {
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: prNumber,
        body,
      },
    );
  } else if (commitSha) {
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
}

module.exports = {
  getDiff,
  getPushDiff,
  getSweepDiff,
  postPRReview,
  postCommitComment,
  postCheckRun,
  postUpgradeComment,
};
