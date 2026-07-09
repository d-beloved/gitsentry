import { supabase } from "../db/client";
import { sortBySeverity, countBySeverity } from "./scorer";
import {
  SEVERITY_EMOJI,
  SEVERITY_ORDER,
} from "../../../../packages/scanner-contract/constants";
import type { Finding, Severity } from "../../../../packages/scanner-contract/types";


const FROM_EMAIL = process.env.FROM_EMAIL;
const PRODUCT_URL = process.env.PRODUCT_URL;

// ─── Slack ────────────────────────────────────────────────────────────────────

async function postToSlack(
  webhookUrl: string,
  params: {
    repoFullName: string;
    issues: Finding[];
    triggerType: string;
    branch: string;
    scanId?: string;
  },
): Promise<void> {
  const { repoFullName, issues, triggerType, branch, scanId } = params;
  const counts = countBySeverity(issues);
  const countParts = (["critical", "high", "medium", "low"] as const)
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`);

  const header = `🔐 *Gitsentry.dev — ${issues.length} issue${issues.length !== 1 ? "s" : ""} in \`${repoFullName}\`*`;
  const meta =
    triggerType === "push_main"
      ? ":warning: *Direct push to main*"
      : `Branch: \`${branch}\``;

  const blocks: unknown[] = [
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
            ? `<${PRODUCT_URL}/dashboard/findings/${issue.id}|View finding>`
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

async function sendAlertEmail(
  to: string,
  params: {
    repoFullName: string;
    issues: Finding[];
    triggerType: string;
    branch: string;
    scanId?: string;
  },
): Promise<void> {
  const { repoFullName, issues, triggerType, branch, scanId } = params;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[notifier] RESEND_API_KEY not set — skipping email alert");
    return;
  }

  const sorted = sortBySeverity(issues);
  const counts = countBySeverity(issues);
  const topSeverity = sorted[0]?.severity ?? "medium";
  const topEmoji = SEVERITY_EMOJI[topSeverity as Severity] ?? "🔐";

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
          ${SEVERITY_EMOJI[issue.severity as Severity] || ""} <strong>${issue.severity.toUpperCase()}</strong>
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
      </tr>`,
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

type EffectiveConfig = {
  slack_webhook: string | null;
  email: string | null;
  min_severity: string;
  alert_on_main: boolean;
};

// Resolves the effective alert destination for a repo: a per-repo alert_config
// takes priority, otherwise the org-level defaults. Returns null when no
// Slack/email destination is configured. Branch/severity gating is left to the
// caller so different alert types (findings vs. scan failures) can apply their
// own rules.
async function resolveAlertConfig(repoId: string): Promise<EffectiveConfig | null> {
  const { data: perRepo } = await supabase
    .from("alert_configs")
    .select("slack_webhook, email, min_severity")
    .eq("repo_id", repoId)
    .single();

  if (perRepo) {
    const c = perRepo as Omit<EffectiveConfig, "alert_on_main">;
    return { ...c, alert_on_main: false };
  }

  const { data: repo } = await supabase
    .from("repos")
    .select("org_id")
    .eq("id", repoId)
    .single();

  if (!repo?.org_id) return null;

  const { data: org } = await supabase
    .from("orgs")
    .select("alert_slack_webhook, alert_email, alert_min_severity, alert_on_main")
    .eq("id", repo.org_id)
    .single();

  const orgAny = org as Record<string, unknown> | null;
  if (!orgAny || (!orgAny.alert_slack_webhook && !orgAny.alert_email)) return null;

  return {
    slack_webhook: (orgAny.alert_slack_webhook as string | null) ?? null,
    email: (orgAny.alert_email as string | null) ?? null,
    min_severity: (orgAny.alert_min_severity as string | null) ?? "high",
    alert_on_main: !!orgAny.alert_on_main,
  };
}

export async function notifyIfNeeded(
  repoId: string,
  repoFullName: string,
  issues: Finding[],
  triggerType: string,
  branch: string,
  scanId?: string,
): Promise<void> {
  if (!issues.length) return;

  const effective = await resolveAlertConfig(repoId);
  if (!effective) return;

  // Respect alert_on_main: skip non-default-branch pushes if set
  const isMainBranch = branch === "main" || branch === "master";
  if (effective.alert_on_main && !isMainBranch && triggerType !== "pull_request") return;

  const threshold = SEVERITY_ORDER[effective.min_severity as Severity] ?? 1;
  const alertable = issues.filter(
    (i) => (SEVERITY_ORDER[i.severity as Severity] ?? 99) <= threshold,
  );
  if (!alertable.length) return;

  const payload = { repoFullName, issues: alertable, triggerType, branch, scanId };
  const promises: Promise<void>[] = [];

  if (effective.slack_webhook) {
    promises.push(
      postToSlack(effective.slack_webhook, payload).catch((err: Error) =>
        console.error("[notifier] Slack failed:", err.message),
      ),
    );
  }

  if (effective.email) {
    promises.push(
      sendAlertEmail(effective.email, payload).catch((err: Error) =>
        console.error("[notifier] email failed:", err.message),
      ),
    );
  }

  if (promises.length) await Promise.all(promises);
}

// ─── Scan-failure alert ───────────────────────────────────────────────────────
// Sent when a scan errored after consuming a scan credit. The credit is
// auto-restored, so the message reassures the user and points them to retry.

const FAILURE_REASON_LABEL: Record<string, string> = {
  pipeline_error: "the scan pipeline hit an error",
  ai_error: "the AI analysis step failed",
};

async function postFailureToSlack(
  webhookUrl: string,
  p: { repoFullName: string; reason: string; creditRefunded: boolean; scanId?: string },
): Promise<void> {
  const detail = FAILURE_REASON_LABEL[p.reason] ?? "the scan could not be completed";
  const creditLine = p.creditRefunded
    ? "Your scan credit has been *restored* — you can retry when ready."
    : "You can retry when ready.";
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ *Gitsentry.dev — scan failed in \`${p.repoFullName}\`*\n${detail[0].toUpperCase()}${detail.slice(1)}. ${creditLine}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${p.scanId ? `scan \`${p.scanId.slice(0, 8)}\` · ` : ""}<${PRODUCT_URL}/dashboard|Retry in dashboard>`,
        },
      ],
    },
  ];
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `Gitsentry.dev — scan failed in ${p.repoFullName}`, blocks }),
  });
  if (!res.ok) throw new Error(`Slack webhook returned HTTP ${res.status}`);
}

async function sendFailureEmail(
  to: string,
  p: { repoFullName: string; reason: string; creditRefunded: boolean; scanId?: string },
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[notifier] RESEND_API_KEY not set — skipping scan-failure email");
    return;
  }
  const detail = FAILURE_REASON_LABEL[p.reason] ?? "the scan could not be completed";
  const creditLine = p.creditRefunded
    ? "Your scan credit has been <strong>restored</strong>, so retrying won't cost you a scan."
    : "You can retry it when ready.";
  const subject = `Scan failed in ${p.repoFullName}${p.creditRefunded ? " — credit restored" : ""}`;
  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:680px;margin:40px auto;background:#0d0d0d;border:1px solid #1f1f1f;border-radius:12px;overflow:hidden">
    <div style="padding:24px 28px;border-bottom:1px solid #1f1f1f">
      <p style="margin:0;color:#888;font-size:13px">Gitsentry.dev</p>
      <h2 style="margin:8px 0 0;color:#fff;font-size:18px">
        A scan failed in <code style="font-size:16px;color:#f59e0b">${p.repoFullName}</code>
      </h2>
    </div>
    <div style="padding:20px 28px;color:#ccc;font-size:14px;line-height:1.6">
      <p style="margin:0 0 12px">We couldn't finish your latest scan — ${detail}.</p>
      <p style="margin:0">${creditLine}</p>
    </div>
    <div style="padding:20px 28px;border-top:1px solid #1f1f1f">
      <a href="${PRODUCT_URL}/dashboard"
         style="display:inline-block;background:#fff;color:#000;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">
        Retry in dashboard
      </a>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #1a1a1a;background:#0a0a0a">
      <p style="margin:0;color:#444;font-size:12px">
        Powered by <a href="${PRODUCT_URL}" style="color:#555;text-decoration:none">Gitsentry.dev</a>
        ${p.scanId ? `&nbsp;·&nbsp; scan <code style="font-size:11px">${p.scanId.slice(0, 8)}</code>` : ""}
      </p>
    </div>
  </div>
</body>
</html>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API returned ${res.status}: ${body}`);
  }
}

// Notifies the repo/org's configured Slack + email that a scan failed. Unlike
// notifyIfNeeded this bypasses the severity threshold (there are no findings —
// the scan itself failed) and always fires regardless of branch.
export async function notifyScanFailure(
  repoId: string,
  repoFullName: string,
  reason: string,
  creditRefunded: boolean,
  scanId?: string,
): Promise<void> {
  const effective = await resolveAlertConfig(repoId);
  if (!effective) return;

  const payload = { repoFullName, reason, creditRefunded, scanId };
  const promises: Promise<void>[] = [];

  if (effective.slack_webhook) {
    promises.push(
      postFailureToSlack(effective.slack_webhook, payload).catch((err: Error) =>
        console.error("[notifier] scan-failure Slack failed:", err.message),
      ),
    );
  }
  if (effective.email) {
    promises.push(
      sendFailureEmail(effective.email, payload).catch((err: Error) =>
        console.error("[notifier] scan-failure email failed:", err.message),
      ),
    );
  }
  if (promises.length) await Promise.all(promises);
}
