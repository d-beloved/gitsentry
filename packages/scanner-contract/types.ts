/** Public scanner contract — findings and analysis shapes emitted by the open-source backend. */

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
  | "csrf"
  | "weak_session_management"
  | "privilege_escalation"
  | "insecure_password_reset"
  | "token_leakage"
  | "command_injection"
  | "nosql_injection"
  | "template_injection"
  | "ssrf"
  | "insecure_file_upload"
  | "sensitive_data_exposure"
  | "crypto_misuse"
  | "insecure_storage"
  | "mass_assignment"
  | "business_logic_abuse"
  | "race_condition"
  | "replay_attack"
  | "timing_attack"
  | "cache_poisoning"
  | "cors_misconfiguration"
  | "security_headers_missing"
  | "debug_exposure"
  | "cloud_misconfiguration"
  | "dependency_risk"
  | "attack_chain"
  | "other";

export type TriggerType =
  | "pull_request"
  | "push"
  | "push_main"
  | "push_branch"
  | "security_sweep";

export type ScanMode = "diff_scan" | "security_sweep";

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
  affected_component?: string | null;
  exploitation_scenario?: string | null;
  impact?: string | null;
  evidence?: string | null;
  confidence?: "high" | "medium" | "low";
  attacker_profile?: string | null;
  is_false_positive?: boolean;
  is_resolved?: boolean;
  resolved_at?: string | null;
  created_at?: string;
}

export interface AIAnalysisResult {
  issues: Finding[];
  summary: string;
  scan_mode?: ScanMode;
  threat_model?: {
    attacker_profiles?: string[];
    entry_points?: string[];
    trust_boundaries?: string[];
    sensitive_assets?: string[];
  };
  attack_chains?: Array<{
    title: string;
    severity: Severity;
    steps: string[];
    impact: string;
    recommended_fix: string;
  }>;
  recommendations?: string[];
}

export interface ScanContext {
  repo: string;
  branch: string;
  triggerType: TriggerType;
  author: string | null;
}

export interface ScanJobData {
  scanId: string;
  repoId: string;
  repoFullName: string;
  diff: string;
  context: ScanContext;
  installationId: number;
  prNumber?: number | null;
  commitSha?: string | null;
  branch: string;
  triggerType: string;
}
