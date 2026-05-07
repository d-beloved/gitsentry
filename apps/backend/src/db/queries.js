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
 * Creates the parent org if needed.
 */
async function getOrCreateRepo(repoFullName, repoGithubId) {
  const { data, error } = await supabase
    .from("repos")
    .upsert(
      { github_id: repoGithubId, full_name: repoFullName },
      { onConflict: "github_id" }
    )
    .select()
    .single();

  if (error) throw new Error(`getOrCreateRepo: ${error.message}`);
  return data;
}

// ─── Scans ────────────────────────────────────────────────────────────────────

/**
 * Inserts a new scan row and returns it.
 */
async function saveScan({
  repoFullName,
  repoGithubId,
  triggerType,
  triggerRef,
  commitSha,
  author,
  filesChanged = 0,
  linesAdded = 0,
}) {
  const repo = await getOrCreateRepo(repoFullName, repoGithubId);

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

module.exports = { saveScan, saveFindings, updateScanStatus, getOrCreateRepo, getPublicStats };
