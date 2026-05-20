const {GoogleGenerativeAI} = require("@google/generative-ai");
const {MAX_DIFF_BYTES} = require("../../../../packages/scanner-contract/constants");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CORE_CATEGORIES = [
  ["hardcoded_secret", "API keys, tokens, passwords, private keys in code"],
  ["missing_auth", "New routes or endpoints with no authentication check"],
  ["sql_injection", "User input concatenated into SQL queries"],
  ["idor", "User-supplied IDs used to fetch resources without ownership check"],
  [
    "verbose_error",
    "Stack traces, internal paths, or DB errors exposed to client",
  ],
  [
    "unvalidated_input",
    "User input passed to dangerous operations without sanitisation",
  ],
  [
    "missing_rate_limit",
    "Auth endpoints or sensitive actions with no rate limiting",
  ],
  ["path_traversal", "User input used in file system operations"],
  ["xss", "Unsanitised user content rendered in HTML responses"],
  ["open_redirect", "User-controlled redirect URLs"],
];

const ADVERSARIAL_CATEGORIES = [
  ["csrf", "State-changing browser requests without CSRF protection"],
  [
    "weak_session_management",
    "Insecure cookies, session fixation, weak expiry, or token reuse",
  ],
  ["privilege_escalation", "Vertical or horizontal permission bypass"],
  ["insecure_password_reset", "Password reset or account recovery bypass"],
  [
    "token_leakage",
    "Access tokens exposed in URLs, logs, browser storage, or third-party calls",
  ],
  [
    "command_injection",
    "User input reaching shell commands or unsafe process execution",
  ],
  ["nosql_injection", "User input altering NoSQL query shape or operators"],
  [
    "template_injection",
    "User input evaluated inside templates or expression engines",
  ],
  ["ssrf", "Attacker-controlled URLs causing server-side requests"],
  [
    "insecure_file_upload",
    "Unsafe upload type, path, storage, or execution handling",
  ],
  [
    "sensitive_data_exposure",
    "PII, secrets, or internal data exposed to the wrong party",
  ],
  [
    "crypto_misuse",
    "Weak encryption, bad randomness, home-grown crypto, or unsafe key handling",
  ],
  [
    "insecure_storage",
    "Sensitive data in localStorage, cookies, logs, or unprotected DB fields",
  ],
  [
    "mass_assignment",
    "Client-controlled fields mutating privileged server-side properties",
  ],
  [
    "business_logic_abuse",
    "Workflow abuse such as bypassing approvals, limits, or payment checks",
  ],
  [
    "race_condition",
    "Concurrent requests causing duplicate, stale, or inconsistent state",
  ],
  [
    "replay_attack",
    "Requests or webhooks that can be reused without freshness checks",
  ],
  [
    "timing_attack",
    "Observable timing differences exposing secrets or validity checks",
  ],
  ["cache_poisoning", "Attacker-controlled content influencing shared caches"],
  ["cors_misconfiguration", "Overly broad CORS exposing authenticated APIs"],
  [
    "security_headers_missing",
    "Missing CSP, HSTS, clickjacking, or content-type protections",
  ],
  [
    "debug_exposure",
    "Debug routes, admin panels, stack traces, or internal tooling exposed",
  ],
  [
    "cloud_misconfiguration",
    "Public buckets, weak IAM, open ports, or deployment leaks",
  ],
  [
    "dependency_risk",
    "Vulnerable, unsafe, or suspicious package/dependency behavior",
  ],
  [
    "attack_chain",
    "Multiple lower-severity weaknesses combined into a larger exploit",
  ],
  ["other", "A real vulnerability that does not fit another category"],
];

const ALL_CATEGORIES = [...CORE_CATEGORIES, ...ADVERSARIAL_CATEGORIES];

/**
 * Analyzes a code diff for security vulnerabilities.
 * @param {string} diff - The raw git diff text
 * @param {object} context - { repo, branch, triggerType, author }
 * @param {object} [options] - { mode?: 'diff_scan' | 'security_sweep' }
 * @returns {Promise<{issues: import('../../../../packages/scanner-contract/types').Finding[], summary: string}>}
 */
async function analyzeCode(diff, context, options = {}) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json"},
  });

  const mode =
    options.mode === "security_sweep" ? "security_sweep" : "diff_scan";
  const prompt = buildPrompt(diff, context, mode);
  const result = await model.generateContent(prompt);
  let text = result.response.text();

  try {
    // LLMs sometimes wrap JSON in markdown blocks despite instructions
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const cleanJson = jsonMatch ? jsonMatch[0] : text;

    const parsed = JSON.parse(cleanJson);
    // Ensure we always return the expected shape
    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      summary: parsed.summary || "Analysis complete.",
      scan_mode: mode,
      threat_model: parsed.threat_model || {},
      attack_chains: Array.isArray(parsed.attack_chains)
        ? parsed.attack_chains
        : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations
        : [],
    };
  } catch (e) {
    console.error("[ai] Response parse error:", e);
    return {issues: [], summary: "Analysis failed — could not parse response."};
  }
}

function analyzeSecuritySweep(input, context) {
  return analyzeCode(
    input,
    {...context, triggerType: "security_sweep"},
    {mode: "security_sweep"},
  );
}

function categoryList(categories) {
  return categories
    .map(([key, description], index) => `${index + 1}. ${key} — ${description}`)
    .join("\n");
}

function buildPrompt(diff, context, mode = "diff_scan") {
  const isSweep = mode === "security_sweep";
  const inputLabel = isSweep
    ? "CODEBASE, DESIGN NOTES, OR SELECTED CONTEXT TO AUDIT"
    : "DIFF TO ANALYSE";
  const scopeRules = isSweep
    ? `
SECURITY SWEEP MODE:
- Perform an adversarial review across frontend, backend, auth, database, infrastructure assumptions, integrations, and dependencies.
- Define attacker profiles, entry points, trust boundaries, and sensitive assets.
- Look for chained attack paths and non-obvious business logic flaws unique to this system.
- You may flag potential risks when context is incomplete, but clearly mark the evidence and confidence.
`
    : `
DIFF SCAN MODE:
- Focus on vulnerabilities introduced or exposed by this diff.
- Prefer concrete, actionable findings over speculative architecture advice.
- If a broader risk is visible but not proven in the diff, only report it when the changed code creates a realistic exploit path.
`;

  return `
You are a senior application security engineer specialising in vulnerabilities
introduced by AI coding assistants (Cursor, Copilot, Claude Code).

AI-generated code has predictable failure patterns. Your job is to identify them,
but also think like a red-team specialist looking for trust-boundary mistakes,
logic flaws, feature abuse, and exploit chains.

CONTEXT:
- Repository: ${context.repo}
- Branch: ${context.branch}
- Trigger: ${context.triggerType}
- Author: ${context.author || "unknown"}
- Scan mode: ${mode}

${scopeRules}

SECURITY CATEGORIES TO CHECK (in order of importance):
${categoryList(ALL_CATEGORIES)}

THREAT MODELING CHECKLIST:
- Attacker profiles: anonymous user, authenticated user, malicious insider, API consumer, compromised integration.
- Entry points: UI actions, API routes, webhooks, background jobs, database reads/writes, third-party callbacks.
- Trust boundaries: browser/server, server/database, GitHub/webhook, AI/provider, worker/queue, external services.
- Sensitive assets: credentials, tokens, PII, private repo code, scan findings, billing state, admin permissions.

${inputLabel}:
${diff.length > MAX_DIFF_BYTES ? diff.slice(0, MAX_DIFF_BYTES) + "\n\n[DIFF TRUNCATED DUE TO SIZE]" : diff}

RESPONSE FORMAT — return ONLY valid JSON, no markdown, no explanation:
{
  "issues": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "category": "<one of the categories above>",
      "file_path": "<file path from diff>",
      "line_number": <number or null>,
      "code_snippet": "<the problematic line or block, max 3 lines>",
      "description": "<plain English explanation of why this is a problem>",
      "fix_suggestion": "<concrete one or two line fix>",
      "affected_component": "<frontend | backend | auth | database | infrastructure | dependency | integration | unknown>",
      "exploitation_scenario": "<step-by-step attacker scenario, concise>",
      "impact": "<what an attacker gains or breaks>",
      "evidence": "<specific code or behavior that supports the finding>",
      "confidence": "high" | "medium" | "low",
      "attacker_profile": "<anonymous | authenticated | insider | api_consumer | compromised_integration | unknown>"
    }
  ],
  "summary": "<one sentence overall security assessment>",
  "threat_model": {
    "attacker_profiles": ["<profiles considered>"],
    "entry_points": ["<entry points observed or inferred>"],
    "trust_boundaries": ["<trust boundaries crossed>"],
    "sensitive_assets": ["<assets at risk>"]
  },
  "attack_chains": [
    {
      "title": "<chain title>",
      "severity": "critical" | "high" | "medium" | "low",
      "steps": ["<step 1>", "<step 2>"],
      "impact": "<combined impact>",
      "recommended_fix": "<architectural or code-level fix>"
    }
  ],
  "recommendations": ["<secure design recommendation>"]
}

RULES:
- Only report real, exploitable issues. No style warnings.
- For diff_scan, do not flood PR comments with generic best practices.
- For security_sweep, be adversarial and include attack chains and design recommendations when supported by evidence or clear inference.
- If no issues found, return { "issues": [], "summary": "No security issues detected.", "attack_chains": [], "recommendations": [] }
- Do not report the same issue twice.
- Severity guide: critical = immediate exploitation possible, high = likely exploitable,
  medium = exploitable in specific conditions, low = best practice violation
`;
}

module.exports = {analyzeCode, analyzeSecuritySweep};
