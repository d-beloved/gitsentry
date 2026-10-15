import {supabase} from "./client";
import {countBySeverity} from "../lib/scorer";
import {effectiveQuotaPeriod} from "../lib/quotaPeriod";
import {matchExisting, type DedupeCandidate} from "../lib/dedupe";
import type {Finding} from "../../../../packages/scanner-contract/types";
import type {
  OrgRow,
  RepoRow,
  ScanRow,
  PublicStatsRow,
  OrgWithUsage,
} from "./types";

// Repos

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
): Promise<OrgWithUsage | null> {
  const {data} = await supabase
    .from("installations")
    .select("org_id, orgs(id, plan, subscription_status, scan_count_month, scan_month, sweep_trials_used, sweep_count_month, sweep_month, paddle_subscription_id)")
    .eq("github_install_id", installationId)
    .single();
  return (data?.orgs as unknown as OrgWithUsage) ?? null;
}

// Scans

export async function getRepoIdByFullName(repoFullName: string): Promise<string | null> {
  const {data} = await supabase
    .from("repos")
    .select("id")
    .eq("full_name", repoFullName)
    .single();
  return (data as {id: string} | null)?.id ?? null;
}

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

export type ScanStatus = "complete" | "failed" | "skipped";

// 'skipped' reasons are benign (intentionally not run); 'failed' reasons are real pipeline errors.
export type ScanFailureReason =
  | "quota_exceeded"
  | "subscription_inactive"
  | "no_org"
  | "no_diff"
  | "ai_error"
  | "pipeline_error";

export async function updateScanStatus(
  scanId: string,
  issues: Array<{severity: string}>,
  durationMs: number = 0,
  status: ScanStatus = "complete",
  opts?: {
    tokensIn?: number;
    tokensOut?: number;
    modelName?: string;
    failureReason?: ScanFailureReason;
    creditRefunded?: boolean;
    /** Admin-only; never shown to customers. */
    errorDetail?: string;
    /** Files this scan read; only findings in these can be marked stale. Omit to supersede nothing. */
    examinedPaths?: string[];
  },
): Promise<boolean> {
  const {critical, high, medium, low} = countBySeverity(issues);
  const hasTokens = opts?.tokensIn != null || opts?.tokensOut != null;
  // Cap so one runaway error (e.g. a stringified HTML error page) can't bloat the row.
  const errorDetail = opts?.errorDetail?.slice(0, 2000) ?? null;

  const {data, error} = await supabase
    .from("scans")
    .update({
      status,
      findings_count: issues.length,
      critical_count: critical,
      high_count: high,
      medium_count: medium,
      low_count: low,
      duration_ms: durationMs,
      // Cleared on success so a retry that completes leaves no stale reason behind.
      failure_reason: opts?.failureReason ?? null,
      error_detail: errorDetail,
      ...(opts?.creditRefunded != null ? { credit_refunded: opts.creditRefunded } : {}),
      ...(hasTokens ? { tokens_in: opts?.tokensIn ?? 0, tokens_out: opts?.tokensOut ?? 0, ai_model: opts?.modelName ?? null } : {}),
    })
    .eq("id", scanId)
    // Tombstone guard: a reaped (refunded) scan must not flip back to 'complete'. Keyed on
    // reaped_at, not status, so a Bull retry can still overwrite its own earlier failure.
    .is("reaped_at", null)
    .select("id");

  if (error) throw new Error(`updateScanStatus: ${error.message}`);

  const written = (data?.length ?? 0) > 0;
  if (!written) {
    console.warn(
      `[db] updateScanStatus(${status}) skipped for scan ${scanId} — row was reaped`,
    );
    return false;
  }

  if (status === "complete") {
    updatePublicStats({findings: issues.length, critical}).catch((err) => {
      console.error("[stats] update failed:", err);
    });
    markStaleFindings(scanId, opts?.examinedPaths ?? []).catch((err) => {
      console.error("[staleness] mark stale failed:", err);
    });
  }

  return true;
}

// AI usage ledger: one row per provider call, for total-spend accounting.

export type AiUsageSurface = "pr_scan" | "security_sweep" | "discovery" | "classifier";

export async function recordAiUsage(params: {
  surface: AiUsageSurface;
  model: string;
  tokensIn: number;
  tokensOut: number;
  scanId?: string | null;
  repoId?: string | null;
}): Promise<void> {
  if (params.tokensIn === 0 && params.tokensOut === 0) return;

  const {error} = await supabase.from("ai_usage").insert({
    surface: params.surface,
    model: params.model,
    tokens_in: params.tokensIn,
    tokens_out: params.tokensOut,
    scan_id: params.scanId ?? null,
    repo_id: params.repoId ?? null,
  });

  if (error) console.error("[ai_usage] recordAiUsage failed:", error.message);
}

// Findings

export async function saveFindings(
  scanId: string,
  issues: Finding[],
): Promise<Finding[]> {
  if (!issues.length) return [];

  const {data: scan, error: scanErr} = await supabase
    .from("scans")
    .select("repo_id, trigger_type, trigger_ref")
    .eq("id", scanId)
    .single();

  if (scanErr)
    throw new Error(`saveFindings: could not fetch scan: ${scanErr.message}`);

  const {repo_id: repoId, trigger_type, trigger_ref} = scan as {
    repo_id: string;
    trigger_type: string;
    trigger_ref: string;
  };

  // Dedupe is best-effort: if the lookup fails, save everything rather than lose a finding.
  const candidates = await getDedupeCandidates(
    repoId,
    scanId,
    {trigger_type, trigger_ref},
    [...new Set(issues.map((i) => i.file_path))],
  ).catch((err: Error) => {
    console.error("[findings] dedupe lookup failed — saving without it:", err.message);
    return [] as DedupeCandidate[];
  });
  const matches = issues.map((issue) => matchExisting(issue, candidates));

  const rows = issues.map((issue, index) => {
    const match = matches[index];
    const linked = match?.kind === "dismissed" || match?.kind === "duplicate";
    return {
      scan_id: scanId,
      repo_id: repoId,
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
      duplicate_of: linked ? match.canonicalId : null,
      is_false_positive: match?.kind === "dismissed",
    };
  });

  const {data, error} = await supabase
    .from("findings")
    .insert(rows)
    .select("id");
  if (error) throw new Error(`saveFindings: ${error.message}`);

  const inserted = data as Array<{id: string}>;
  const saved = issues.map((issue, index) => ({
    ...issue,
    id: inserted?.[index]?.id,
    duplicate_of: rows[index].duplicate_of,
    is_false_positive: rows[index].is_false_positive,
  }));

  // The new row takes over as the group's canonical; the old one is about to go stale.
  for (const [index, match] of matches.entries()) {
    const newId = saved[index].id;
    if (match?.kind !== "supersedes" || !newId) continue;
    const {error: moveErr} = await supabase
      .from("findings")
      .update({duplicate_of: newId})
      .eq("duplicate_of", match.canonicalId);
    if (moveErr) console.error("[findings] re-pointing duplicates failed:", moveErr.message);
  }

  return saved;
}

/** Canonical, unresolved, non-stale findings in these files from other scans of the repo. */
async function getDedupeCandidates(
  repoId: string,
  scanId: string,
  trigger: {trigger_type: string; trigger_ref: string},
  filePaths: string[],
): Promise<DedupeCandidate[]> {
  const {data, error} = await supabase
    .from("findings")
    .select("id, category, file_path, line_number, code_snippet, is_false_positive, scans!inner(trigger_type, trigger_ref)")
    .eq("repo_id", repoId)
    .in("file_path", filePaths)
    .is("duplicate_of", null)
    .eq("is_resolved", false)
    .eq("is_stale", false)
    .neq("scan_id", scanId);
  if (error) throw new Error(error.message);

  type Row = Omit<DedupeCandidate, "sameTrigger"> & {
    scans: {trigger_type: string; trigger_ref: string} | null;
  };
  return ((data ?? []) as unknown as Row[]).map(({scans, ...row}) => ({
    ...row,
    is_false_positive: !!row.is_false_positive,
    sameTrigger:
      scans?.trigger_type === trigger.trigger_type && scans?.trigger_ref === trigger.trigger_ref,
  }));
}

export async function getLastPRScanResult(
  repoFullName: string,
  prNumber: number,
): Promise<{findingsCount: number} | null> {
  const {data: repo} = await supabase
    .from("repos")
    .select("id")
    .eq("full_name", repoFullName)
    .single();

  if (!repo) return null;

  const {data} = await supabase
    .from("scans")
    .select("findings_count")
    .eq("repo_id", (repo as {id: string}).id)
    .eq("trigger_type", "pull_request")
    .eq("trigger_ref", String(prNumber))
    .eq("status", "complete")
    .order("created_at", {ascending: false})
    .limit(1)
    .single();

  const row = data as {findings_count: number | null} | null;
  if (!row) return null;
  return {findingsCount: row.findings_count ?? 0};
}

export async function getPreviousPRCommentId(
  repoId: string,
  prNumber: number,
): Promise<{commentId: number; hadFindings: boolean} | null> {
  const {data} = await supabase
    .from("scans")
    .select("gh_comment_id, findings_count")
    .eq("repo_id", repoId)
    .eq("trigger_type", "pull_request")
    .eq("trigger_ref", String(prNumber))
    .not("gh_comment_id", "is", null)
    .order("created_at", {ascending: false})
    .limit(1)
    .single();
  const row = data as {gh_comment_id: number | null; findings_count: number | null} | null;
  if (!row?.gh_comment_id) return null;
  return {commentId: row.gh_comment_id, hadFindings: (row.findings_count ?? 0) > 0};
}

export async function updateScanCommentId(
  scanId: string,
  commentId: number,
): Promise<void> {
  await supabase
    .from("scans")
    .update({gh_comment_id: commentId})
    .eq("id", scanId);
}

// Public stats

async function updatePublicStats(params: {
  findings: number;
  critical: number;
}): Promise<void> {
  const [existing, {data: scannedRepoRows}] = await Promise.all([
    getPublicStats(),
    supabase.from("scans").select("repo_id").eq("status", "complete"),
  ]);
  if (!existing) return;

  const scannedRepoCount = new Set(scannedRepoRows?.map((s: any) => s.repo_id) ?? []).size;

  const {error} = await supabase
    .from("public_stats")
    .update({
      total_scans: Number(existing.total_scans ?? 0) + 1,
      total_findings: Number(existing.total_findings ?? 0) + params.findings,
      critical_caught: Number(existing.critical_caught ?? 0) + params.critical,
      total_repos: Math.max(scannedRepoCount, Number(existing.total_repos ?? 0)),
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id);

  if (error) throw new Error(`updatePublicStats: ${error.message}`);
}

// Only findings in files this scan examined may go stale: a `synchronize` scan sees just the
// incremental diff, so its silence about other files is not evidence of a fix.
async function markStaleFindings(
  scanId: string,
  examinedPaths: string[],
): Promise<void> {
  if (!examinedPaths.length) return;

  const {data: scan} = await supabase
    .from("scans")
    .select("repo_id, trigger_ref, trigger_type")
    .eq("id", scanId)
    .single();

  if (!scan) return;

  const {data: prevScans} = await supabase
    .from("scans")
    .select("id")
    .eq("repo_id", (scan as {repo_id: string; trigger_ref: string; trigger_type: string}).repo_id)
    .eq("trigger_ref", (scan as {repo_id: string; trigger_ref: string; trigger_type: string}).trigger_ref)
    .eq("trigger_type", (scan as {repo_id: string; trigger_ref: string; trigger_type: string}).trigger_type)
    .eq("status", "complete")
    .neq("id", scanId);

  if (!prevScans?.length) return;

  const {data: retired} = await supabase
    .from("findings")
    .update({is_stale: true})
    .in("scan_id", prevScans.map((s) => (s as {id: string}).id))
    .in("file_path", examinedPaths)
    .eq("is_resolved", false)
    .eq("is_false_positive", false)
    .eq("is_stale", false)
    .select("id");

  const retiredIds = ((retired ?? []) as {id: string}[]).map((r) => r.id);
  if (retiredIds.length) await promoteDuplicates(retiredIds);
}

// A retired canonical hands its group to its oldest open duplicate, so an issue still present
// in another PR doesn't vanish from the dashboard along with it.
async function promoteDuplicates(retiredIds: string[]): Promise<void> {
  const {data} = await supabase
    .from("findings")
    .select("id, duplicate_of, is_resolved, is_false_positive, is_stale")
    .in("duplicate_of", retiredIds)
    .order("created_at", {ascending: true});

  type Row = {id: string; duplicate_of: string; is_resolved: boolean; is_false_positive: boolean; is_stale: boolean};
  const groups = new Map<string, Row[]>();
  for (const row of (data ?? []) as Row[]) {
    groups.set(row.duplicate_of, [...(groups.get(row.duplicate_of) ?? []), row]);
  }

  for (const [oldId, rows] of groups) {
    const heir = rows.find((r) => !r.is_resolved && !r.is_false_positive && !r.is_stale);
    if (!heir) continue;
    await supabase.from("findings").update({duplicate_of: null}).eq("id", heir.id);
    await supabase
      .from("findings")
      .update({duplicate_of: heir.id})
      .eq("duplicate_of", oldId);
  }
}

/** Still-open findings from earlier scans of this PR, so a narrow incremental scan can't read as clean. */
export async function getOpenPRFindings(
  repoId: string,
  prNumber: number,
  excludeScanId: string,
): Promise<Finding[]> {
  const {data: priorScans} = await supabase
    .from("scans")
    .select("id")
    .eq("repo_id", repoId)
    .eq("trigger_type", "pull_request")
    .eq("trigger_ref", String(prNumber))
    .eq("status", "complete")
    .neq("id", excludeScanId);

  if (!priorScans?.length) return [];

  const {data, error} = await supabase
    .from("findings")
    .select("*")
    .in("scan_id", priorScans.map((s) => (s as {id: string}).id))
    .eq("is_resolved", false)
    .eq("is_false_positive", false)
    .eq("is_stale", false);

  if (error) {
    console.error("[findings] getOpenPRFindings failed:", error.message);
    return [];
  }

  return (data ?? []) as Finding[];
}

async function getPublicStats(): Promise<PublicStatsRow | null> {
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

// Security sweep

export async function saveSweepScan(
  repoId: string,
  branch: string,
): Promise<ScanRow> {
  await supabase.from("repos").update({is_active: true}).eq("id", repoId);

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

// Atomically claims the one-time sweep trial; false if already used.
export async function tryClaimSweepTrial(orgId: string): Promise<boolean> {
  const {data, error} = await supabase
    .from("orgs")
    .update({sweep_trials_used: 1})
    .eq("id", orgId)
    .eq("sweep_trials_used", 0)
    .select("id");
  if (error) {
    console.error(
      "[db] tryClaimSweepTrial error — sweep requests will be BLOCKED for non-pro orgs until resolved:",
      error.message,
    );
    return false;
  }
  return !!((data as Array<{id: string}> | null)?.length);
}

export async function refundSweepTrial(orgId: string): Promise<void> {
  await supabase
    .from("orgs")
    .update({sweep_trials_used: 0})
    .eq("id", orgId);
}

// Paid plans pass their stored sweep_month so the counter resets only on the Paddle
// renewal webhook, never on a calendar boundary.
export async function tryClaimMonthlySweep(
  orgId: string,
  sweepLimit: number,
  plan: string = "free",
  storedSweepMonth: string | null = null,
  hasPaddleSubscription: boolean = false,
): Promise<boolean> {
  const effectiveMonth = effectiveQuotaPeriod({
    plan,
    anchor: storedSweepMonth,
    hasPaddleSubscription,
  });
  const {data, error} = await supabase.rpc("try_claim_sweep", {
    p_org_id: orgId,
    p_month: effectiveMonth,
    p_limit: sweepLimit,
  });
  if (error) {
    console.error(
      "[db] tryClaimMonthlySweep rpc error — sweep BLOCKED (fail-closed):",
      error.message,
    );
    return false;
  }
  return !!data;
}

export async function refundMonthlySweep(orgId: string): Promise<void> {
  const {error} = await supabase.rpc("refund_sweep", {p_org_id: orgId});
  if (error) {
    console.error("[db] refundMonthlySweep rpc error:", error.message);
  }
}

// Billing helpers

export async function getOrgByRepoId(
  repoId: string,
): Promise<OrgWithUsage | null> {
  const {data, error} = await supabase
    .from("repos")
    .select(
      "org_id, orgs(id, plan, scan_count_month, scan_month, sweep_trials_used, sweep_count_month, sweep_month, subscription_status, paddle_subscription_id)",
    )
    .eq("id", repoId)
    .single();

  if (error || !data) return null;
  return (data as unknown as {orgs: OrgWithUsage | null}).orgs ?? null;
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

// Prevents IDOR (repoId from org A + installationId from org B) and guards against a
// stale installation_id on the repos row by cross-checking the installations table.
export async function verifyRepoInstallation(
  repoId: string,
  installationId: number,
): Promise<boolean> {
  const {data: repoData} = await supabase
    .from("repos")
    .select("id, org_id")
    .eq("id", repoId)
    .eq("installation_id", installationId)
    .single();

  if (!repoData) return false;

  const {data: installData} = await supabase
    .from("installations")
    .select("org_id")
    .eq("github_install_id", installationId)
    .single();

  if (!installData?.org_id) return false;
  return installData.org_id === (repoData as {id: string; org_id: string | null}).org_id;
}

// Repo security context

export interface CachedSecurityContext {
  context: string;
  updatedAt: string | null;
}

export async function getRepoSecurityContext(repoId: string): Promise<CachedSecurityContext | null> {
  const {data} = await supabase
    .from("repos")
    .select("security_context, security_context_updated_at")
    .eq("id", repoId)
    .single();
  const row = data as {security_context: string | null; security_context_updated_at: string | null} | null;
  if (!row?.security_context) return null;
  return {context: row.security_context, updatedAt: row.security_context_updated_at};
}

export async function saveRepoSecurityContext(repoId: string, context: string): Promise<void> {
  await supabase
    .from("repos")
    .update({security_context: context, security_context_updated_at: new Date().toISOString()})
    .eq("id", repoId);
}

/** Categories dismissed as false positives 2+ times in this repo (learned suppression rules). */
export async function getFalsePositivePatterns(
  repoId: string,
): Promise<{category: string; count: number}[]> {
  const {data} = await supabase
    .from("findings")
    .select("category")
    .eq("repo_id", repoId)
    .eq("is_false_positive", true);

  if (!data?.length) return [];

  const counts: Record<string, number> = {};
  for (const row of data as {category: string}[]) {
    counts[row.category] = (counts[row.category] ?? 0) + 1;
  }

  return Object.entries(counts)
    .filter(([, count]) => count >= 2)
    .map(([category, count]) => ({category, count}));
}

/** Quota-claim idempotency marker, so a Bull retry never consumes a second slot. */
export async function scanQuotaAlreadyClaimed(scanId: string): Promise<boolean> {
  const {data, error} = await supabase
    .from("scans")
    .select("quota_claimed")
    .eq("id", scanId)
    .single();
  if (error) {
    // Unknown state: treat as unclaimed.
    console.error("[db] scanQuotaAlreadyClaimed failed:", error.message);
    return false;
  }
  return !!data?.quota_claimed;
}

export async function markScanQuotaClaimed(scanId: string): Promise<void> {
  const {error} = await supabase
    .from("scans")
    .update({quota_claimed: true})
    .eq("id", scanId);
  if (error) console.error("[db] markScanQuotaClaimed failed:", error.message);
}

// Stranded scan recovery: rows left 'pending' by a dropped job or dead worker (see lib/reaper.ts).

export interface StrandedScanRow {
  id: string;
  repo_id: string;
  created_at: string;
  /** Null until the worker picks the job up. */
  started_at: string | null;
  quota_claimed: boolean | null;
  credit_refunded: boolean | null;
  /** 'pull_request' | 'push_main' | 'push_branch' */
  trigger_type: string;
  /** The PR number, as a string, when trigger_type is 'pull_request'. */
  trigger_ref: string;
  commit_sha: string;
  repos: {full_name: string; installation_id: number | null} | null;
}

// commit_sha/trigger_*/installation_id are for the check run the reaper closes out.
const STRANDED_COLUMNS =
  "id, repo_id, created_at, started_at, quota_claimed, credit_refunded, " +
  "trigger_type, trigger_ref, commit_sha, repos(full_name, installation_id)";

// Never-started scans are judged by queue age (must exceed any plausible backlog wait);
// started scans by run age of the current attempt. The two sets are disjoint.
export async function getStrandedScans(
  queueCutoffIso: string,
  runCutoffIso: string,
  limit: number,
): Promise<StrandedScanRow[]> {
  const [neverStarted, stalledMidRun] = await Promise.all([
    supabase
      .from("scans")
      .select(STRANDED_COLUMNS)
      .eq("status", "pending")
      .is("started_at", null)
      .lt("created_at", queueCutoffIso)
      .order("created_at", {ascending: true})
      .limit(limit),
    supabase
      .from("scans")
      .select(STRANDED_COLUMNS)
      .eq("status", "pending")
      .not("started_at", "is", null)
      .lt("started_at", runCutoffIso)
      .order("started_at", {ascending: true})
      .limit(limit),
  ]);

  if (neverStarted.error) {
    console.error("[db] getStrandedScans (never started) failed:", neverStarted.error.message);
  }
  if (stalledMidRun.error) {
    console.error("[db] getStrandedScans (stalled mid-run) failed:", stalledMidRun.error.message);
  }

  const rows = [
    ...((neverStarted.data ?? []) as unknown as StrandedScanRow[]),
    ...((stalledMidRun.data ?? []) as unknown as StrandedScanRow[]),
  ];

  // Re-cap: each query applied `limit` independently, so the union can be up to 2x.
  return rows
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(0, limit);
}

// Stamps this attempt's start (re-stamped per retry). Returns false for a reaped scan,
// so the worker abandons it before spending any tokens.
export async function markScanStarted(scanId: string): Promise<boolean> {
  const {data, error} = await supabase
    .from("scans")
    .update({started_at: new Date().toISOString()})
    .eq("id", scanId)
    .is("reaped_at", null)
    .select("id");

  if (error) {
    // Fail open: worst case the reaper judges this row by queue age.
    console.error("[db] markScanStarted failed:", error.message);
    return true;
  }
  return (data?.length ?? 0) > 0;
}

/** Quota bookkeeping flags, read together so a retry can't double-refund. */
export async function getScanRefundState(
  scanId: string,
): Promise<{quotaClaimed: boolean; creditRefunded: boolean}> {
  const {data, error} = await supabase
    .from("scans")
    .select("quota_claimed, credit_refunded")
    .eq("id", scanId)
    .single();

  if (error) {
    // Unknown state: report "already refunded". A missed refund is recoverable; a double refund isn't.
    console.error("[db] getScanRefundState failed:", error.message);
    return {quotaClaimed: false, creditRefunded: true};
  }
  return {
    quotaClaimed: !!data?.quota_claimed,
    creditRefunded: !!data?.credit_refunded,
  };
}

// The status='pending' filter makes this an atomic claim: only one reaper (or the worker)
// wins, so the credit is refunded exactly once. False when someone else got there first.
export async function claimStrandedScan(
  scanId: string,
  errorDetail: string,
): Promise<boolean> {
  const {data, error} = await supabase
    .from("scans")
    .update({
      status: "failed",
      failure_reason: "pipeline_error",
      error_detail: errorDetail.slice(0, 2000),
      // Tombstone: updateScanStatus refuses to write once set.
      reaped_at: new Date().toISOString(),
      findings_count: 0,
      critical_count: 0,
      high_count: 0,
      medium_count: 0,
      low_count: 0,
    })
    .eq("id", scanId)
    .eq("status", "pending")
    .select("id");

  if (error) {
    console.error("[db] claimStrandedScan failed:", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

export async function markScanCreditRefunded(scanId: string): Promise<void> {
  const {error} = await supabase
    .from("scans")
    .update({credit_refunded: true})
    .eq("id", scanId);
  if (error) console.error("[db] markScanCreditRefunded failed:", error.message);
}

// Paid plans pass their stored scan_month so the counter resets only on the Paddle renewal webhook.
export async function tryClaimScan(
  orgId: string,
  scanLimit: number,
  plan: string = "free",
  storedScanMonth: string | null = null,
  hasPaddleSubscription: boolean = false,
): Promise<boolean> {
  const effectiveMonth = effectiveQuotaPeriod({
    plan,
    anchor: storedScanMonth,
    hasPaddleSubscription,
  });
  const {data, error} = await supabase.rpc("try_claim_scan", {
    p_org_id: orgId,
    p_month: effectiveMonth,
    p_limit: scanLimit,
  });
  if (error) {
    // Fail closed: a broken quota mechanism must block scans, not grant unlimited access.
    console.error(
      "[db] tryClaimScan rpc error — quota enforcement BLOCKED (fail-closed). Ensure the try_claim_scan function exists in your Supabase project:",
      error.message,
    );
    return false;
  }
  return !!data;
}

// effectiveMonth must match tryClaimScan's so the refund lands in the claim's billing month.
export async function refundScanSlot(
  orgId: string,
  plan: string = "free",
  storedScanMonth: string | null = null,
  hasPaddleSubscription: boolean = false,
): Promise<void> {
  const effectiveMonth = effectiveQuotaPeriod({
    plan,
    anchor: storedScanMonth,
    hasPaddleSubscription,
  });
  const {error} = await supabase.rpc("refund_scan", {
    p_org_id: orgId,
    p_month: effectiveMonth,
  });
  if (error) console.error("[db] refundScanSlot rpc error:", error.message);
}

// Eval runs

export async function createEvalRun(params: {
  label: string | null;
  provider: string;
  model: string;
  verifierEnabled: boolean;
  structuredMode: string | null;
  fixturesTotal: number;
}): Promise<string> {
  const {data, error} = await supabase
    .from("eval_runs")
    .insert({
      status: "running",
      label: params.label,
      provider: params.provider,
      model: params.model,
      verifier_enabled: params.verifierEnabled,
      structured_mode: params.structuredMode,
      fixtures_total: params.fixturesTotal,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create eval run: ${error?.message ?? "no row"}`);
  }
  return data.id as string;
}

// Upsert so a re-run overwrites rather than double-counts; errors are logged, not thrown.
export async function saveEvalCase(
  runId: string,
  c: {
    fixtureId: string;
    fixtureName: string;
    isClean: boolean;
    expected: number;
    detected: number;
    extras: number;
    durationMs: number;
    error: string | null;
    findings: {category: string; file: string; severity: string}[];
    misses: string[];
    tokensIn: number;
    tokensOut: number;
    cachedTokens: number;
  },
  fixturesDone: number,
): Promise<void> {
  const {error} = await supabase.from("eval_run_cases").upsert(
    {
      run_id: runId,
      fixture_id: c.fixtureId,
      fixture_name: c.fixtureName,
      is_clean: c.isClean,
      expected: c.expected,
      detected: c.detected,
      extras: c.extras,
      duration_ms: c.durationMs,
      error: c.error,
      findings: c.findings,
      misses: c.misses,
      tokens_in: c.tokensIn,
      tokens_out: c.tokensOut,
      cached_tokens: c.cachedTokens,
    },
    {onConflict: "run_id,fixture_id"},
  );

  if (error) console.error("[eval] saveEvalCase failed:", error.message);

  const {error: progressError} = await supabase
    .from("eval_runs")
    .update({fixtures_done: fixturesDone})
    .eq("id", runId);

  if (progressError) {
    console.error("[eval] progress update failed:", progressError.message);
  }
}

export async function completeEvalRun(
  runId: string,
  totals: {
    expectedTotal: number;
    detected: number;
    cleanFPs: number;
    extras: number;
    tokensIn: number;
    tokensOut: number;
    cachedTokens: number;
    durationMs: number;
  },
): Promise<void> {
  const {error} = await supabase
    .from("eval_runs")
    .update({
      status: "completed",
      expected_total: totals.expectedTotal,
      detected: totals.detected,
      clean_fps: totals.cleanFPs,
      extras: totals.extras,
      tokens_in: totals.tokensIn,
      tokens_out: totals.tokensOut,
      cached_tokens: totals.cachedTokens,
      duration_ms: totals.durationMs,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) console.error("[eval] completeEvalRun failed:", error.message);
}

/** Only for a sweep that dies; per-fixture errors are recorded on the case. */
export async function failEvalRun(runId: string, message: string): Promise<void> {
  const {error} = await supabase
    .from("eval_runs")
    .update({
      status: "failed",
      error: message.slice(0, 2000),
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) console.error("[eval] failEvalRun failed:", error.message);
}

/** Two concurrent evals would contend for the same rate limit and skew both. */
export async function evalRunInFlight(): Promise<boolean> {
  const {data, error} = await supabase
    .from("eval_runs")
    .select("id")
    .eq("status", "running")
    // A run that outlived a deploy is stranded, not in flight.
    .gt("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
    .limit(1);

  if (error) {
    console.error("[eval] evalRunInFlight check failed:", error.message);
    return false;
  }
  return (data ?? []).length > 0;
}
