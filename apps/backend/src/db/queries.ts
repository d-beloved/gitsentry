import {supabase} from "./client";
import {countBySeverity} from "../lib/scorer";
import type {Finding} from "../../../../packages/scanner-contract/types";
import type {
  OrgRow,
  RepoRow,
  ScanRow,
  PublicStatsRow,
  OrgSummary,
  OrgWithUsage,
} from "./types";

// ─── Repos ────────────────────────────────────────────────────────────────────

export async function getOrCreateOrg(params: {
  githubId: number;
  login: string;
  avatarUrl: string | null;
}): Promise<{id: string}> {
  const {data, error} = await supabase
    .from("orgs")
    .upsert(
      {
        github_id: params.githubId,
        login: params.login,
        avatar_url: params.avatarUrl,
      },
      {onConflict: "github_id"},
    )
    .select("id")
    .single();

  if (error) throw new Error(`getOrCreateOrg: ${error.message}`);
  return data as {id: string};
}

export async function getOrCreateRepo(
  repoFullName: string,
  repoGithubId: number,
  orgId: string | null = null,
  installationId: number | null = null,
  isPrivate: boolean = false,
  isActive: boolean | null = null,
): Promise<RepoRow> {
  const upsertData: Record<string, unknown> = {
    github_id: repoGithubId,
    full_name: repoFullName,
    is_private: isPrivate,
  };
  if (orgId) upsertData.org_id = orgId;
  if (installationId) upsertData.installation_id = installationId;
  if (isActive !== null) upsertData.is_active = isActive;

  const {data, error} = await supabase
    .from("repos")
    .upsert(upsertData, {onConflict: "github_id"})
    .select()
    .single();

  if (error) throw new Error(`getOrCreateRepo: ${error.message}`);
  return data as RepoRow;
}

export async function getOrgByInstallationId(
  installationId: number,
): Promise<OrgSummary | null> {
  const {data} = await supabase
    .from("installations")
    .select("org_id, orgs(id, plan)")
    .eq("github_install_id", installationId)
    .single();
  return (data?.orgs as unknown as OrgSummary) ?? null;
}

// ─── Scans ────────────────────────────────────────────────────────────────────

export async function scanExistsForCommit(
  repoFullName: string,
  commitSha: string,
): Promise<boolean> {
  const {data: repo} = await supabase
    .from("repos")
    .select("id")
    .eq("full_name", repoFullName)
    .single();

  if (!repo) return false;

  const {data} = await supabase
    .from("scans")
    .select("id")
    .eq("repo_id", (repo as {id: string}).id)
    .eq("commit_sha", commitSha)
    .limit(1);

  return !!data?.length;
}

export async function saveScan(params: {
  repoFullName: string;
  repoGithubId: number;
  repoOwner: {githubId: number; login: string; avatarUrl: string | null} | null;
  installationId?: number | null;
  isPrivate?: boolean;
  triggerType: string;
  triggerRef: string;
  commitSha: string;
  author: string | null;
  filesChanged?: number;
  linesAdded?: number;
}): Promise<ScanRow> {
  const {
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
  } = params;

  let orgId: string | null = null;
  if (repoOwner) {
    const org = await getOrCreateOrg({
      githubId: repoOwner.githubId,
      login: repoOwner.login,
      avatarUrl: repoOwner.avatarUrl,
    });
    orgId = org.id;
  }

  const repo = await getOrCreateRepo(
    repoFullName,
    repoGithubId,
    orgId,
    installationId,
    isPrivate,
    true,
  );

  const {data, error} = await supabase
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
  return data as ScanRow;
}

export async function updateScanStatus(
  scanId: string,
  issues: Array<{severity: string}>,
  durationMs: number = 0,
  status: "complete" | "failed" = "complete",
): Promise<void> {
  const {critical, high, medium, low} = countBySeverity(issues);

  const {error} = await supabase
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
    updatePublicStats({findings: issues.length, critical}).catch((err) => {
      console.error("[stats] update failed:", err);
    });
  }
}

// ─── Findings ─────────────────────────────────────────────────────────────────

export async function saveFindings(
  scanId: string,
  issues: Finding[],
): Promise<Finding[]> {
  if (!issues.length) return [];

  const {data: scan, error: scanErr} = await supabase
    .from("scans")
    .select("repo_id")
    .eq("id", scanId)
    .single();

  if (scanErr)
    throw new Error(`saveFindings: could not fetch scan: ${scanErr.message}`);

  const rows = issues.map((issue) => ({
    scan_id: scanId,
    repo_id: (scan as {repo_id: string}).repo_id,
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

  const {data, error} = await supabase
    .from("findings")
    .insert(rows)
    .select("id");
  if (error) throw new Error(`saveFindings: ${error.message}`);

  const inserted = data as Array<{id: string}>;
  return issues.map((issue, index) => ({
    ...issue,
    id: inserted?.[index]?.id,
  }));
}

/** Returns the GitHub comment ID from the most recent PR scan comment, if any. */
export async function getPreviousPRCommentId(
  repoId: string,
  prNumber: number,
): Promise<number | null> {
  const {data} = await supabase
    .from("scans")
    .select("gh_comment_id")
    .eq("repo_id", repoId)
    .eq("trigger_type", "pull_request")
    .eq("trigger_ref", String(prNumber))
    .not("gh_comment_id", "is", null)
    .order("created_at", {ascending: false})
    .limit(1)
    .single();
  return (data as {gh_comment_id: number | null} | null)?.gh_comment_id ?? null;
}

/** Persists the GitHub comment ID returned after posting/updating a PR comment. */
export async function updateScanCommentId(
  scanId: string,
  commentId: number,
): Promise<void> {
  await supabase
    .from("scans")
    .update({gh_comment_id: commentId})
    .eq("id", scanId);
}

// ─── Public stats ─────────────────────────────────────────────────────────────

async function updatePublicStats(params: {
  findings: number;
  critical: number;
}): Promise<void> {
  const existing = await getPublicStats();
  if (!existing) return;

  const {error} = await supabase
    .from("public_stats")
    .update({
      total_scans: Number(existing.total_scans ?? 0) + 1,
      total_findings: Number(existing.total_findings ?? 0) + params.findings,
      critical_caught: Number(existing.critical_caught ?? 0) + params.critical,
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id);

  if (error) throw new Error(`updatePublicStats: ${error.message}`);
}

export async function getPublicStats(): Promise<PublicStatsRow | null> {
  const {data, error} = await supabase
    .from("public_stats")
    .select("*")
    .order("updated_at", {ascending: false})
    .limit(1)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new Error(`getPublicStats: ${error.message}`);
  }

  return data as PublicStatsRow;
}

// ─── Security sweep ───────────────────────────────────────────────────────────

export async function saveSweepScan(
  repoId: string,
  branch: string,
): Promise<ScanRow> {
  const {data, error} = await supabase
    .from("scans")
    .insert({
      repo_id: repoId,
      trigger_type: "security_sweep",
      trigger_ref: branch,
      commit_sha: `sweep-${Date.now()}`,
      author: null,
      files_changed: 0,
      lines_added: 0,
      status: "pending",
    })
    .select()
    .single();

  if (error) throw new Error(`saveSweepScan: ${error.message}`);
  return data as ScanRow;
}

export async function incrementSweepTrials(orgId: string): Promise<void> {
  const {data: org} = await supabase
    .from("orgs")
    .select("sweep_trials_used")
    .eq("id", orgId)
    .single();

  await supabase
    .from("orgs")
    .update({
      sweep_trials_used: ((org as OrgRow | null)?.sweep_trials_used ?? 0) + 1,
    })
    .eq("id", orgId);
}

// ─── Billing helpers ──────────────────────────────────────────────────────────

export async function getOrgByRepoId(
  repoId: string,
): Promise<OrgWithUsage | null> {
  const {data, error} = await supabase
    .from("repos")
    .select(
      "org_id, orgs(id, plan, scan_count_month, scan_month, sweep_trials_used, subscription_status)",
    )
    .eq("id", repoId)
    .single();

  if (error || !data) return null;
  return (data as unknown as {orgs: OrgWithUsage | null}).orgs ?? null;
}

export async function incrementScanCount(orgId: string): Promise<void> {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const {data: org} = await supabase
    .from("orgs")
    .select("scan_count_month, scan_month")
    .eq("id", orgId)
    .single();

  const row = org as Pick<OrgRow, "scan_count_month" | "scan_month"> | null;
  const needsReset = !row || row.scan_month !== currentMonth;

  await supabase
    .from("orgs")
    .update({
      scan_count_month: needsReset ? 1 : (row?.scan_count_month ?? 0) + 1,
      scan_month: currentMonth,
    })
    .eq("id", orgId);
}

export async function updateOrgPlan(
  orgId: string,
  params: {
    plan?: string;
    paddleCustomerId?: string;
    paddleSubscriptionId?: string;
    subscriptionStatus?: string;
  },
): Promise<void> {
  const update: Record<string, string> = {};
  if (params.plan !== undefined) update.plan = params.plan;
  if (params.paddleCustomerId !== undefined)
    update.paddle_customer_id = params.paddleCustomerId;
  if (params.paddleSubscriptionId !== undefined)
    update.paddle_subscription_id = params.paddleSubscriptionId;
  if (params.subscriptionStatus !== undefined)
    update.subscription_status = params.subscriptionStatus;

  const {error} = await supabase.from("orgs").update(update).eq("id", orgId);
  if (error) throw new Error(`updateOrgPlan: ${error.message}`);
}

export async function getOrgByPaddleCustomer(
  paddleCustomerId: string,
): Promise<OrgRow | null> {
  const {data} = await supabase
    .from("orgs")
    .select("*")
    .eq("paddle_customer_id", paddleCustomerId)
    .single();
  return (data as OrgRow | null) ?? null;
}

export async function getRepoRow(
  repoId: string,
): Promise<{github_id: number; full_name: string; org_id: string | null; is_private: boolean} | null> {
  const {data} = await supabase
    .from("repos")
    .select("github_id, full_name, org_id, is_private")
    .eq("id", repoId)
    .single();
  return data as {github_id: number; full_name: string; org_id: string | null; is_private: boolean} | null;
}

// Confirms that the given repo is actually owned by the given GitHub App
// installation. Used by the sweep endpoint to prevent IDOR where a caller
// mixes a repoId from org A with an installationId from org B.
export async function verifyRepoInstallation(
  repoId: string,
  installationId: number,
): Promise<boolean> {
  const {data} = await supabase
    .from("repos")
    .select("id")
    .eq("id", repoId)
    .eq("installation_id", installationId)
    .single();
  return !!data;
}

// Atomically checks the monthly scan limit and increments the counter in one
// operation, eliminating the TOCTOU race in the old SELECT-then-UPDATE pattern.

// Returns true if a scan slot was claimed, false if the limit was already reached.
export async function tryClaimScan(
  orgId: string,
  scanLimit: number,
): Promise<boolean> {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const {data, error} = await supabase.rpc("try_claim_scan", {
    p_org_id: orgId,
    p_month: currentMonth,
    p_limit: scanLimit,
  });
  if (error) {
    console.error("[db] tryClaimScan rpc error:", error.message);
    // Fall back to permitting the scan rather than silently blocking all scans
    // if the function hasn't been created yet.
    return true;
  }
  return !!data;
}
