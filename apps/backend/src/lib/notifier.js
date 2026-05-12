const { supabase } = require("../db/client");
const { sortBySeverity, countBySeverity } = require("./scorer");

const SEVERITY_EMOJI = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" };
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const PRODUCT_URL = "https://gitsentry.dev";
const FROM_EMAIL = "Gitsentry.dev <alerts@gitsentry.dev>";

// ─── Slack ────────────────────────────────────────────────────────────────────

async function postToSlack(webhookUrl, { repoFullName, issues, triggerType, branch, scanId }) {
  const counts = countBySeverity(issues);
  const countParts = ["critical", "high", "medium", "low"]
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`);

  const header = `🔐 *Gitsentry.dev — ${issues.length} issue${issues.length !== 1 ? "s" : ""} in \`${repoFullName}\`*`;
  const meta =
    triggerType === "push_main"
      ? ":warning: *Direct push to main*"
      : `Branch: \`${branch}\``;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${header}\n${meta}${countParts.length ? `  ·  ${countParts.join(", ")}` : ""}`,
      },
    },
    { type: "divider" },
    ...issues.slice(0, 5).map((issue) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `${SEVERITY_EMOJI[issue.severity] || "⚪"} *${issue.severity.toUpperCase()} — ${issue.category}*`,
          `\`${issue.file_path}${issue.line_number ? `:${issue.line_number}` : ""}\``,
          issue.description,
          issue.fix_suggestion ? `_Fix: ${issue.fix_suggestion}_` : "",
          issue.id
            ? `<${PRODUCT_URL}/dashboard/findings/${issue.id}|View finding>  ·  <${PRODUCT_URL}/api/findings/${issue.id}/dismiss|Dismiss>`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    })),
  ];

  if (issues.length > 5) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_…and ${issues.length - 5} more. <${PRODUCT_URL}/dashboard|View all in dashboard>_`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: scanId
          ? `scan \`${scanId.slice(0, 8)}\` · <${PRODUCT_URL}|gitsentry.dev>`
          : `<${PRODUCT_URL}|gitsentry.dev>`,
      },
    ],
  });

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: header, blocks }),
  });

  if (!res.ok) throw new Error(`Slack webhook returned HTTP ${res.status}`);
}

// ─── Email (Resend) ───────────────────────────────────────────────────────────

async function sendAlertEmail(to, { repoFullName, issues, triggerType, branch, scanId }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[notifier] RESEND_API_KEY not set — skipping email alert");
    return;
  }

  const sorted = sortBySeverity(issues);
  const counts = countBySeverity(issues);
  const topSeverity = sorted[0]?.severity ?? "medium";
  const topEmoji = SEVERITY_EMOJI[topSeverity] ?? "🔐";

  const subject = `${topEmoji} ${counts.critical ? "CRITICAL: " : ""}${issues.length} security issue${issues.length !== 1 ? "s" : ""} found in ${repoFullName}`;

  const triggerLine =
    triggerType === "push_main"
      ? `⚠️ <strong>Direct push to main</strong>`
      : `Branch: <code style="background:#1a1a1a;padding:2px 6px;border-radius:4px">${branch}</code>`;

  const rows = sorted
    .map(
      (issue) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #1f1f1f;white-space:nowrap">
          ${SEVERITY_EMOJI[issue.severity] || ""} <strong>${issue.severity.toUpperCase()}</strong>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #1f1f1f;font-family:monospace;font-size:12px;color:#aaa">
          ${issue.file_path}${issue.line_number ? `:${issue.line_number}` : ""}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #1f1f1f;color:#ccc;font-size:13px">
          ${issue.description}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #1f1f1f;white-space:nowrap">
          ${
            issue.id
              ? `<a href="${PRODUCT_URL}/dashboard/findings/${issue.id}" style="color:#4ade80;text-decoration:none;font-size:12px">View</a>
                 &nbsp;·&nbsp;
                 <a href="${PRODUCT_URL}/api/findings/${issue.id}/dismiss" style="color:#555;text-decoration:none;font-size:12px">Dismiss</a>`
              : ""
          }
        </td>
      </tr>`
    )
    .join("");

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:680px;margin:40px auto;background:#0d0d0d;border:1px solid #1f1f1f;border-radius:12px;overflow:hidden">
    <div style="padding:24px 28px;border-bottom:1px solid #1f1f1f">
      <p style="margin:0;color:#888;font-size:13px">Gitsentry.dev Security Alert</p>
      <h2 style="margin:8px 0 0;color:#fff;font-size:18px">
        ${issues.length} security issue${issues.length !== 1 ? "s" : ""} found in
        <code style="font-size:16px;color:#4ade80">${repoFullName}</code>
      </h2>
      <p style="margin:8px 0 0;color:#666;font-size:13px">${triggerLine}</p>
    </div>
    <div style="padding:0 28px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="color:#555;text-align:left">
            <th style="padding:10px 12px;font-weight:500">Severity</th>
            <th style="padding:10px 12px;font-weight:500">Location</th>
            <th style="padding:10px 12px;font-weight:500">Issue</th>
            <th style="padding:10px 12px"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="padding:24px 28px;border-top:1px solid #1f1f1f">
      <a href="${PRODUCT_URL}/dashboard"
         style="display:inline-block;background:#fff;color:#000;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">
        View in dashboard →
      </a>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #1a1a1a;background:#0a0a0a">
      <p style="margin:0;color:#444;font-size:12px">
        Powered by <a href="${PRODUCT_URL}" style="color:#555;text-decoration:none">Gitsentry.dev</a>
        &nbsp;·&nbsp;
        <a href="${PRODUCT_URL}/dashboard/settings" style="color:#555;text-decoration:none">Manage alerts</a>
        ${scanId ? `&nbsp;·&nbsp; scan <code style="font-size:11px">${scanId.slice(0, 8)}</code>` : ""}
      </p>
    </div>
  </div>
</body>
</html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API returned ${res.status}: ${body}`);
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Looks up alert config for the repo and fires Slack / email if any
 * findings meet the configured minimum severity.
 *
 * @param {string} repoId
 * @param {string} repoFullName
 * @param {Array}  issues      findings with .id set (post-saveFindings)
 * @param {string} triggerType
 * @param {string} branch
 * @param {string} [scanId]
 */
async function notifyIfNeeded(repoId, repoFullName, issues, triggerType, branch, scanId) {
  if (!issues.length) return;

  const { data: config } = await supabase
    .from("alert_configs")
    .select("*")
    .eq("repo_id", repoId)
    .single();

  if (!config) return;

  const threshold = SEVERITY_ORDER[config.min_severity] ?? 1; // default: high
  const alertable = issues.filter((i) => (SEVERITY_ORDER[i.severity] ?? 99) <= threshold);
  if (!alertable.length) return;

  const payload = { repoFullName, issues: alertable, triggerType, branch, scanId };
  const promises = [];

  if (config.slack_webhook) {
    promises.push(
      postToSlack(config.slack_webhook, payload).catch((err) =>
        console.error("[notifier] Slack failed:", err.message)
      )
    );
  }

  if (config.email) {
    promises.push(
      sendAlertEmail(config.email, payload).catch((err) =>
        console.error("[notifier] email failed:", err.message)
      )
    );
  }

  if (promises.length) await Promise.all(promises);
}

module.exports = { notifyIfNeeded };
