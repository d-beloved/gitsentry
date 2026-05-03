// TODO (Phase 3): Implement Slack and email notifications.
//
// This module will:
//   - Query alert_configs for the repo to get slack_webhook, email, and min_severity
//   - Post a Slack message via incoming webhook when findings meet min_severity
//   - Send an email digest via SendGrid / Resend
//
// Interface (do not change the signature):
//   notifyIfNeeded(repoFullName, issues, triggerType, branch) → Promise<void>

async function notifyIfNeeded(_repoFullName, _issues, _triggerType, _branch) {
  // no-op until Phase 3
}

module.exports = { notifyIfNeeded };
