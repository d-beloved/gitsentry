import {supabase} from "./client";
import {countBySeverity} from "../lib/scorer";
import {effectiveQuotaPeriod} from "../lib/quotaPeriod";
import type {Finding} from "../../../../packages/scanner-contract/types";
import type {
  OrgRow,
  RepoRow,
  ScanRow,
  PublicStatsRow,
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
): Promise<OrgWithUsage | null> {
  const {data} = await supabase
    .from("installations")
    .select("org_id, orgs(id, plan, subscription_status, scan_count_month, scan_month, sweep_trials_used, sweep_count_month, sweep_month, paddle_subscription_id)")
    .eq("github_install_id", installationId)
    .single();
  return (data?.orgs as unknown as OrgWithUsage) ?? null;
}

// ─── Scans ────────────────────────────────────────────────────────────────────

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

// Why a scan did not complete. 'skipped' outcomes are benign (the scan was
// intentionally not run); 'failed' outcomes are real pipeline errors.
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
    /** Raw exception message for admin diagnosis — never shown to customers. */
    errorDetail?: string;
    /**
     * The files this scan actually looked at. Only findings living in one of
     * these paths can be superseded by this scan's result — see
     * markStaleFindings. Omitting it supersedes nothing, which is the safe
     * default for callers that never ran a diff (skips, failures).
     */
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
      // Clear on success, set on skip/failure — so a re-run that finally
      // completes doesn't leave a stale reason/detail behind.
      failure_reason: opts?.failureReason ?? null,
      error_detail: errorDetail,
      ...(opts?.creditRefunded != null ? { credit_refunded: opts.creditRefunded } : {}),
      ...(hasTokens ? { tokens_in: opts?.tokensIn ?? 0, tokens_out: opts?.tokensOut ?? 0, ai_model: opts?.modelName ?? null } : {}),
    })
    .eq("id", scanId)
    // Tombstone guard (migration 007). The reaper has already closed this row out
    // and refunded the credit; a worker that finishes afterwards must not flip it
    // back to 'complete' and post results against a scan the customer was told
    // had failed. Deliberately keyed on reaped_at and NOT on status: a scan that
    // failed on Bull attempt 1 has status='failed' with reaped_at NULL, and its
    // retry must still be able to overwrite that failure on success.
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

// ─── AI usage ledger ────────────────────────────────────────────────────────────
// Records every AI provider call regardless of which feature made it, so the
// finance dashboard can account for total spend rather than just the main
// scan/sweep call. See docs/migrations/002_ai_usage_ledger.sql.

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

/** Returns the findings count of the last completed scan for a PR, or null if none exists yet. */
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

/** Returns the comment ID and whether the previous scan had findings, or null if no prior comment exists. */
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

/**
 * Marks open findings from previous scans of the same repo+trigger as stale when
 * a newer scan completes — but ONLY those living in a file the new scan actually
 * examined (`examinedPaths`).
 *
 * The scope matters because a `synchronize` scan reads the incremental diff
 * (see handlePR), so a follow-up commit that touches one unrelated file used to
 * retire every finding on the PR — including ones in files the scanner never
 * re-read. That is how a real HIGH could be silently retired by a six-line
 * README fix. "The newest scan didn't report it" is only evidence of a fix when
 * the newest scan looked at the file in the first place.
 *
 * A file deleted by this scan's diff still appears in examinedPaths
 * (extractScannablePaths counts deletions), so removing vulnerable code retires
 * its findings exactly as it should.
 *
 * Passing an empty examinedPaths supersedes nothing — the safe default.
 */
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

  await supabase
    .from("findings")
    .update({is_stale: true})
    .in("scan_id", prevScans.map((s) => (s as {id: string}).id))
    .in("file_path", examinedPaths)
    .eq("is_resolved", false)
    .eq("is_false_positive", false)
    .eq("is_stale", false);
}

/**
 * Open findings raised by earlier scans of the same PR that are still live:
 * not resolved, not dismissed, and not superseded by a later scan that re-read
 * their file. The worker carries these into the PR comment so a scan of a
 * narrow incremental diff can't present the PR as clean.
 */
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

// ─── Security sweep ───────────────────────────────────────────────────────────

export async function saveSweepScan(
  repoId: string,
  branch: string,
): Promise<ScanRow> {
  // Mark active — a successful sweep confirms the installation is working
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

// Atomically claims the one-time sweep trial for non-pro orgs.
// Returns true if the slot was claimed (sweep_trials_used was 0), false if already used.
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

// Resets sweep_trials_used to 0 — called when the sweep fails before producing results.
export async function refundSweepTrial(orgId: string): Promise<void> {
  await supabase
    .from("orgs")
    .update({sweep_trials_used: 0})
    .eq("id", orgId);
}

// Atomically claims a monthly sweep slot for Starter and Pro orgs.
// Uses the same SELECT...FOR UPDATE pattern as try_claim_scan to prevent races.
// For paid plans, pass the org's stored sweep_month so the RPC never resets on a
// calendar boundary — only Paddle's transaction.completed webhook resets the counter.
// For free users this path is never reached (they use tryClaimSweepTrial instead).
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

// Atomically decrements sweep_count_month by 1 — called when a sweep fails before
// producing results so the user is not charged for a broken run.
export async function refundMonthlySweep(orgId: string): Promise<void> {
  const {error} = await supabase.rpc("refund_sweep", {p_org_id: orgId});
  if (error) {
    console.error("[db] refundMonthlySweep rpc error:", error.message);
  }
}

// ─── Billing helpers ──────────────────────────────────────────────────────────

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

// Confirms that the given repo is actually owned by the given GitHub App
// installation by cross-referencing the installations table. This prevents IDOR
// where a caller mixes a repoId from org A with an installationId from org B,
// and also guards against a stale installation_id column on the repos row.
export async function verifyRepoInstallation(
  repoId: string,
  installationId: number,
): Promise<boolean> {
  // Primary check: the repo's recorded installation_id must match
  const {data: repoData} = await supabase
    .from("repos")
    .select("id, org_id")
    .eq("id", repoId)
    .eq("installation_id", installationId)
    .single();

  if (!repoData) return false;

  // Secondary check: cross-reference through the installations table to confirm
  // the installation actually belongs to the same org as the repo, guarding
  // against a stale installation_id in the repos row.
  const {data: installData} = await supabase
    .from("installations")
    .select("org_id")
    .eq("github_install_id", installationId)
    .single();

  if (!installData?.org_id) return false;
  return installData.org_id === (repoData as {id: string; org_id: string | null}).org_id;
}

// ─── Repo security context ────────────────────────────────────────────────────

export interface CachedSecurityContext {
  context: string;
  updatedAt: string | null;
}

/** Returns the stored per-repo security context + when it was last discovered, or null if not yet discovered. */
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

/** Persists the per-repo security context (discovered patterns + learned false-positive rules). */
export async function saveRepoSecurityContext(repoId: string, context: string): Promise<void> {
  await supabase
    .from("repos")
    .update({security_context: context, security_context_updated_at: new Date().toISOString()})
    .eq("id", repoId);
}

/**
 * Returns categories that have been marked as false positives 2+ times in this
 * repo. Used to append learned suppression rules to the security context.
 */
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

// Atomically checks the monthly scan limit and increments the counter in one
// operation, eliminating the TOCTOU race in the old SELECT-then-UPDATE pattern.
// Returns true if a scan slot was claimed, false if the limit was already reached.
// For paid plans, pass the org's stored scan_month so the RPC never resets on a
// calendar boundary — only Paddle's transaction.completed webhook resets the counter.
/**
 * Idempotency marker for quota claims. The worker checks this before claiming
 * a quota slot so a Bull retry of a scan that already claimed (then failed
 * later in the pipeline) never consumes a second slot.
 */
export async function scanQuotaAlreadyClaimed(scanId: string): Promise<boolean> {
  const {data, error} = await supabase
    .from("scans")
    .select("quota_claimed")
    .eq("id", scanId)
    .single();
  if (error) {
    // Unknown state — treat as unclaimed; worst case matches old behaviour.
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

// ─── Stranded scan recovery ─────────────────────────────────────────────────
// A scan row is created as 'pending' before the job is dispatched. If the queue
// accepts the job but the worker never runs it (Redis throttled, dropped by a
// non-persistent Redis on restart, worker killed mid-job), the row stays
// 'pending' forever: the customer paid a credit and the dashboard shows a scan
// that never resolves. The reaper finds those rows and closes them out
// truthfully. See lib/reaper.ts.

export interface StrandedScanRow {
  id: string;
  repo_id: string;
  created_at: string;
  /** Null until the worker picks the job up. See markScanStarted. */
  started_at: string | null;
  quota_claimed: boolean | null;
  credit_refunded: boolean | null;
  repos: {full_name: string} | null;
}

const STRANDED_COLUMNS =
  "id, repo_id, created_at, started_at, quota_claimed, credit_refunded, repos(full_name)";

/**
 * Scans that are stuck rather than merely waiting. The two cases need different
 * clocks, so they are two queries rather than one cutoff:
 *
 *   never consumed (started_at IS NULL)  — judged by queue age. A job Redis
 *     dropped looks identical to one queued behind a backlog, so this threshold
 *     has to sit beyond any plausible queue wait (see SCAN_QUEUE_TIMEOUT_MINUTES).
 *
 *   died mid-run (started_at IS NOT NULL) — judged by run age, measured from the
 *     current attempt's pickup. No healthy scan runs this long, so this one can
 *     be tight without risking a false positive.
 *
 * The sets are disjoint by construction (started_at null vs not null), so the
 * union needs no dedup.
 */
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

  // Oldest first across both sets, and re-cap: each query applied `limit`
  // independently, so the union can be up to 2x it.
  return rows
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(0, limit);
}

/**
 * Stamps the current attempt's pickup time, and doubles as the worker's
 * permission check: the `reaped_at IS NULL` filter means a scan the reaper has
 * already closed out returns false, and the worker abandons it before spending
 * a single AI token on results nobody will accept.
 *
 * Re-stamped on every Bull retry on purpose — started_at means "this attempt
 * began at", which is what the run-age threshold above needs.
 */
export async function markScanStarted(scanId: string): Promise<boolean> {
  const {data, error} = await supabase
    .from("scans")
    .update({started_at: new Date().toISOString()})
    .eq("id", scanId)
    .is("reaped_at", null)
    .select("id");

  if (error) {
    // Fail open: a stamping failure must not stop a scan that is otherwise fine.
    // Worst case the reaper judges this row by queue age, which is the old behaviour.
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
    // Unknown state — claim "already refunded" so we err towards not refunding
    // twice. An unrefunded credit is recoverable by support; an over-refund
    // silently hands out free scans.
    console.error("[db] getScanRefundState failed:", error.message);
    return {quotaClaimed: false, creditRefunded: true};
  }
  return {
    quotaClaimed: !!data?.quota_claimed,
    creditRefunded: !!data?.credit_refunded,
  };
}

/**
 * Flips a stranded scan 'pending' → 'failed'. The status filter makes this the
 * atomic claim: if two backend instances reap concurrently — or the worker
 * finally wakes up and completes the scan first — only the caller that actually
 * changed the row gets a row back, so the credit is refunded exactly once.
 * Returns false when someone else got there first.
 */
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
      // Tombstone (migration 007) — updateScanStatus refuses to write once this
      // is set, so a worker that wakes up later cannot undo this row.
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
    // Fail closed: a broken quota mechanism must block scans rather than grant
    // unlimited free access. Operators must ensure try_claim_scan exists in Supabase.
    console.error(
      "[db] tryClaimScan rpc error — quota enforcement BLOCKED (fail-closed). Ensure the try_claim_scan function exists in your Supabase project:",
      error.message,
    );
    return false;
  }
  return !!data;
}

// Releases one monthly scan slot previously claimed via tryClaimScan. Called
// when a scan errors after claiming its slot but before producing results, so a
// genuine failure never costs the customer a scan. effectiveMonth is derived the
// same way as tryClaimScan so the refund lands in the exact billing month the
// slot was claimed in (refund_scan no-ops if the month has since rolled over).
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
