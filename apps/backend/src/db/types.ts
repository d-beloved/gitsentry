export type OrgPlan = "free" | "starter" | "pro";
export type ScanStatus = "pending" | "complete" | "failed";

export interface OrgRow {
  id: string;
  github_id: number;
  login: string;
  avatar_url: string | null;
  plan: OrgPlan;
  scan_count_month: number | null;
  scan_month: string | null;
  sweep_trials_used: number;
  paddle_customer_id: string | null;
  paddle_subscription_id: string | null;
  subscription_status: string | null;
}

export interface RepoRow {
  id: string;
  github_id: number;
  full_name: string;
  org_id: string | null;
  installation_id: number | null;
  is_private: boolean;
  is_active: boolean;
  security_context: string | null;
}

export interface ScanRow {
  id: string;
  repo_id: string;
  trigger_type: string;
  trigger_ref: string;
  commit_sha: string;
  author: string | null;
  files_changed: number;
  lines_added: number;
  status: ScanStatus;
  findings_count?: number;
  critical_count?: number;
  high_count?: number;
  medium_count?: number;
  low_count?: number;
  duration_ms?: number;
  gh_comment_id?: number | null;
  created_at?: string;
}

export interface AlertConfigRow {
  id: string;
  repo_id: string;
  min_severity: string;
  slack_webhook: string | null;
  email: string | null;
}

export interface PublicStatsRow {
  id: string;
  total_scans: number;
  total_findings: number;
  total_repos: number;
  critical_caught: number;
  updated_at: string;
}

/** Minimal org shape returned by installation/repo lookups */
export interface OrgSummary {
  id: string;
  plan: OrgPlan;
  subscription_status: string | null;
}

/** Extended org shape used for scan-limit gating in the worker and sweep enforcement */
export interface OrgWithUsage extends OrgSummary {
  scan_count_month: number | null;
  scan_month: string | null;
  sweep_trials_used: number;
  sweep_count_month: number | null;
  sweep_month: string | null;
}
