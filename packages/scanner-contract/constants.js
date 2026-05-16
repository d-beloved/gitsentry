/** @type {Record<string, number>} */
const SEVERITY_ORDER = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** @type {Record<string, string>} */
const SEVERITY_EMOJI = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
};

/** @type {Record<string, string>} */
const CATEGORY_LABELS = {
  hardcoded_secret: "Hardcoded Secret",
  missing_auth: "Missing Authentication",
  sql_injection: "SQL Injection",
  idor: "Insecure Direct Object Reference (IDOR)",
  verbose_error: "Verbose Error Exposure",
  unvalidated_input: "Unvalidated Input",
  missing_rate_limit: "Missing Rate Limit",
  insecure_deserialization: "Insecure Deserialization",
  path_traversal: "Path Traversal",
  xss: "Cross-Site Scripting (XSS)",
  open_redirect: "Open Redirect",
  csrf: "Cross-Site Request Forgery (CSRF)",
  weak_session_management: "Weak Session Management",
  privilege_escalation: "Privilege Escalation",
  insecure_password_reset: "Insecure Password Reset",
  token_leakage: "Token Leakage",
  command_injection: "Command Injection",
  nosql_injection: "NoSQL Injection",
  template_injection: "Template Injection",
  ssrf: "Server-Side Request Forgery (SSRF)",
  insecure_file_upload: "Insecure File Upload",
  sensitive_data_exposure: "Sensitive Data Exposure",
  crypto_misuse: "Cryptography Misuse",
  insecure_storage: "Insecure Storage",
  mass_assignment: "Mass Assignment",
  business_logic_abuse: "Business Logic Abuse",
  race_condition: "Race Condition",
  replay_attack: "Replay Attack",
  timing_attack: "Timing Attack",
  cache_poisoning: "Cache Poisoning",
  cors_misconfiguration: "CORS Misconfiguration",
  security_headers_missing: "Missing Security Headers",
  debug_exposure: "Debug or Admin Exposure",
  cloud_misconfiguration: "Cloud or Storage Misconfiguration",
  dependency_risk: "Dependency or Supply Chain Risk",
  attack_chain: "Attack Chain",
  other: "Other",
};

const FINDING_CATEGORIES = Object.keys(CATEGORY_LABELS);

const MAIN_BRANCHES = ["main", "master"];

const MAX_DIFF_BYTES = 12000;

/** Hosted product URL (used in GitHub review comment links). */
const GITSENTRY_URL = "https://gitsentry.dev";

module.exports = {
  SEVERITY_ORDER,
  SEVERITY_EMOJI,
  CATEGORY_LABELS,
  FINDING_CATEGORIES,
  MAIN_BRANCHES,
  MAX_DIFF_BYTES,
  GITSENTRY_URL,
};
