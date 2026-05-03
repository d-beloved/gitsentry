export type Severity = "critical" | "high" | "medium" | "low";

export type FindingCategory =
  | "hardcoded_secret"
  | "missing_auth"
  | "sql_injection"
  | "idor"
  | "verbose_error"
  | "unvalidated_input"
  | "missing_rate_limit"
  | "insecure_deserialization"
  | "path_traversal"
  | "xss"
  | "open_redirect"
  | "other";

export type TriggerType = "pull_request" | "push" | "push_main" | "push_branch";

export type Plan = "free" | "pro" | "team";

export interface Finding {
  id?: string;
  scan_id?: string;
  repo_id?: string;
  severity: Severity;
  category: FindingCategory;
  file_path: string;
  line_number: number | null;
  code_snippet: string | null;
  description: string;
  fix_suggestion: string;
  is_false_positive?: boolean;
  is_resolved?: boolean;
  resolved_at?: string | null;
  created_at?: string;
}

export interface Scan {
  id: string;
  repo_id: string;
  trigger_type: TriggerType;
  trigger_ref: string;
  commit_sha: string;
  author: string | null;
  files_changed: number;
  lines_added: number;
  findings_count: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  status: "pending" | "complete" | "failed";
  duration_ms: number | null;
  created_at: string;
}

export interface Repo {
  id: string;
  org_id: string;
  github_id: number;
  full_name: string;
  default_branch: string;
  is_active: boolean;
  watch_prs: boolean;
  watch_pushes: boolean;
  watch_main: boolean;
  created_at: string;
}

export interface Org {
  id: string;
  github_id: number;
  login: string;
  avatar_url: string | null;
  plan: Plan;
  created_at: string;
}

export interface AIAnalysisResult {
  issues: Finding[];
  summary: string;
}

export interface ScanContext {
  repo: string;
  branch: string;
  triggerType: TriggerType;
  author: string | null;
}
