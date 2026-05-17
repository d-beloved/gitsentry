const { supabase } = require("./client");
const { countBySeverity } = require("../lib/scorer");

// ─── Repos ────────────────────────────────────────────────────────────────────

/**
 * Upserts an org row and returns its id.
 */
async function getOrCreateOrg({ githubId, login, avatarUrl }) {
  const { data, error } = await supabase
    .from("orgs")
    .upsert({ github_id: githubId, login, avatar_url: avatarUrl }, { onConflict: "github_id" })
    .select("id")
    .single();

  if (error) throw new Error(`getOrCreateOrg: ${error.message}`);
  return data;
}

/**
 * Upserts a repo row and returns the full row.
 * Pass orgId to link the repo to its owner org.
 */
async function getOrCreateRepo(repoFullName, repoGithubId, orgId = null, installationId = null, isPrivate = false, isActive = null) {
  const upsertData = { github_id: repoGithubId, full_name: repoFullName, is_private: isPrivate };
  if (orgId) upsertData.org_id = orgId;
  if (installationId) upsertData.installation_id = installationId;
  if (isActive !== null) upsertData.is_active = isActive;

  const { data, error } = await supabase
    .from("repos")
    .upsert(upsertData, { onConflict: "github_id" })
    .select()
    .single();

  if (error) throw new Error(`getOrCreateRepo: ${error.message}`);
  return data;
}

/**
 * Looks up the org (with plan) linked to a GitHub App installation ID.
 * Used to check plan before processing webhooks for private repos.
 */
async function getOrgByInstallationId(installationId) {
  const { data } = await supabase
    .from("installations")
    .select("org_id, orgs(id, plan)")
    .eq("github_install_id", installationId)
    .single();
  return data?.orgs ?? null;
}

// ─── Scans ────────────────────────────────────────────────────────────────────

/**
 * Inserts a new scan row and returns it.
 * repoOwner: { githubId, login, avatarUrl } — the GitHub account that owns the repo
 *   (individual user or org). Used to populate org_id on the repo row.
 */
async function saveScan({
  repoFullName,
  repoGithubId,
  repoOwner,
  installationId = null,
  isPrivate = false,
  triggerType,
  triggerRef,
  commitSha,
  author,
  filesChanged = 0,
  linesAdded = 0,
}) {
  let orgId = null;
  if (repoOwner) {
    const org = await getOrCreateOrg({
      githubId: repoOwner.githubId,
      login: repoOwner.login,
      avatarUrl: repoOwner.avatarUrl,
    });
    orgId = org.id;
  }

  const repo = await getOrCreateRepo(repoFullName, repoGithubId, orgId, installationId, isPrivate, true);

  const { data, error } = await supabase
    .from("scans")
    .insert({
      repo_id: repo.id,
      trigger_type: triggerType,
      trigger_ref: triggerRef,
      commit_sha: commitSha,
      author,
      files_changed: filesChanged,
      lines_added: linesAdded,
      status: "pending",
    })
    .select()
    .single();

  if (error) throw new Error(`saveScan: ${error.message}`);
  return data;
}

/**
 * Updates a scan row with final counts and status once analysis is complete.
 */
async function updateScanStatus(scanId, issues, durationMs = 0, status = "complete") {
  const { critical, high, medium, low } = countBySeverity(issues);

  const { error } = await supabase
    .from("scans")
    .update({
      status,
      findings_count: issues.length,
      critical_count: critical,
      high_count: high,
      medium_count: medium,
      low_count: low,
      duration_ms: durationMs,
    })
    .eq("id", scanId);

  if (error) throw new Error(`updateScanStatus: ${error.message}`);

  if (status === "complete") {
    updatePublicStats({ findings: issues.length, critical }).catch((err) => {
      console.error("[stats] update failed:", err);
    });
  }
}

// ─── Findings ─────────────────────────────────────────────────────────────────

/**
 * Bulk-inserts all findings for a scan.
 */
async function saveFindings(scanId, issues) {
  if (!issues.length) return [];

  // Look up repo_id from the scan row
  const { data: scan, error: scanErr } = await supabase
    .from("scans")
    .select("repo_id")
    .eq("id", scanId)
    .single();

  if (scanErr) throw new Error(`saveFindings: could not fetch scan: ${scanErr.message}`);

  const rows = issues.map((issue) => ({
    scan_id: scanId,
    repo_id: scan.repo_id,
    severity: issue.severity,
    category: issue.category,
    file_path: issue.file_path,
    line_number: issue.line_number ?? null,
    code_snippet: issue.code_snippet ?? null,
    description: issue.description,
    fix_suggestion: issue.fix_suggestion,
    affected_component: issue.affected_component ?? null,
    exploitation_scenario: issue.exploitation_scenario ?? null,
    impact: issue.impact ?? null,
    evidence: issue.evidence ?? null,
    confidence: issue.confidence ?? null,
    attacker_profile: issue.attacker_profile ?? null,
  }));

  const { data, error } = await supabase.from("findings").insert(rows).select("id");
  if (error) throw new Error(`saveFindings: ${error.message}`);

  return issues.map((issue, index) => ({
    ...issue,
    id: data?.[index]?.id,
  }));
}

// ─── Public stats ─────────────────────────────────────────────────────────────

async function updatePublicStats({ findings, critical }) {
  const existing = await getPublicStats();
  if (!existing) return;

  const { error } = await supabase
    .from("public_stats")
    .update({
      total_scans: Number(existing.total_scans ?? 0) + 1,
      total_findings: Number(existing.total_findings ?? 0) + findings,
      critical_caught: Number(existing.critical_caught ?? 0) + critical,
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id);

  if (error) throw new Error(`updatePublicStats: ${error.message}`);
}

/**
 * Returns the latest cached public stats row.
 */
async function getPublicStats() {
  const { data, error } = await supabase
    .from("public_stats")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new Error(`getPublicStats: ${error.message}`);
  }

  return data;
}

// ─── Security sweep ───────────────────────────────────────────────────────────

/**
 * Inserts a scan row for a security sweep (repo already exists — no org/repo upsert needed).
 */
async function saveSweepScan(repoId, branch) {
  const { data, error } = await supabase
    .from("scans")
    .insert({
      repo_id: repoId,
      trigger_type: "security_sweep",
      trigger_ref: branch,
      commit_sha: `sweep-${new Date().toISOString().slice(0, 10)}`,
      author: null,
      files_changed: 0,
      lines_added: 0,
      status: "pending",
    })
    .select()
    .single();

  if (error) throw new Error(`saveSweepScan: ${error.message}`);
  return data;
}

/**
 * Increments the sweep trial counter on an org (used to gate free-tier sweeps).
 */
async function incrementSweepTrials(orgId) {
  const { data: org } = await supabase
    .from("orgs")
    .select("sweep_trials_used")
    .eq("id", orgId)
    .single();

  await supabase
    .from("orgs")
    .update({ sweep_trials_used: (org?.sweep_trials_used ?? 0) + 1 })
    .eq("id", orgId);
}

// ─── Billing helpers ──────────────────────────────────────────────────────────

/**
 * Returns the org row for a given repo, including plan + usage fields.
 */
async function getOrgByRepoId(repoId) {
  const { data, error } = await supabase
    .from("repos")
    .select("org_id, orgs(id, plan, scan_count_month, scan_month, sweep_trials_used)")
    .eq("id", repoId)
    .single();

  if (error || !data) return null;
  return data.orgs ?? null;
}

/**
 * Increments scan_count_month for an org, resetting to 1 when the calendar month changes.
 */
async function incrementScanCount(orgId) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const { data: org } = await supabase
    .from("orgs")
    .select("scan_count_month, scan_month")
    .eq("id", orgId)
    .single();

  const needsReset = !org || org.scan_month !== currentMonth;

  await supabase.from("orgs").update({
    scan_count_month: needsReset ? 1 : (org.scan_count_month || 0) + 1,
    scan_month: currentMonth,
  }).eq("id", orgId);
}

/**
 * Updates org plan + Paddle subscription fields.
 */
async function updateOrgPlan(orgId, { plan, paddleCustomerId, paddleSubscriptionId, subscriptionStatus }) {
  const update = {};
  if (plan !== undefined)                   update.plan = plan;
  if (paddleCustomerId !== undefined)       update.paddle_customer_id = paddleCustomerId;
  if (paddleSubscriptionId !== undefined)   update.paddle_subscription_id = paddleSubscriptionId;
  if (subscriptionStatus !== undefined)     update.subscription_status = subscriptionStatus;

  const { error } = await supabase.from("orgs").update(update).eq("id", orgId);
  if (error) throw new Error(`updateOrgPlan: ${error.message}`);
}

/**
 * Looks up an org by Paddle customer ID.
 */
async function getOrgByPaddleCustomer(paddleCustomerId) {
  const { data } = await supabase
    .from("orgs")
    .select("*")
    .eq("paddle_customer_id", paddleCustomerId)
    .single();
  return data ?? null;
}

module.exports = {
  saveScan,
  saveFindings,
  updateScanStatus,
  getOrCreateRepo,
  getPublicStats,
  saveSweepScan,
  incrementSweepTrials,
  getOrgByRepoId,
  getOrgByInstallationId,
  incrementScanCount,
  updateOrgPlan,
  getOrgByPaddleCustomer,
};
