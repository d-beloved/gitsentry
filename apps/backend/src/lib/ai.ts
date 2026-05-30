import { GoogleGenerativeAI } from "@google/generative-ai";
import { extractWithContext } from "./differ";
import type { AIAnalysisResult, ScanContext } from "../../../../packages/scanner-contract/types";

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not set — cannot start without AI provider");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CORE_CATEGORIES: [string, string][] = [
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

const ADVERSARIAL_CATEGORIES: [string, string][] = [
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

export async function analyzeCode(
  diff: string,
  context: ScanContext,
  options: { mode?: "diff_scan" | "security_sweep" } = {},
): Promise<AIAnalysisResult> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" },
  });

  const mode = options.mode === "security_sweep" ? "security_sweep" : "diff_scan";
  const input = mode === "diff_scan" ? extractWithContext(diff) : diff;
  const prompt = buildPrompt(input, context, mode);

  const AI_TIMEOUT_MS = 120_000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`[ai] Gemini call timed out after ${AI_TIMEOUT_MS / 1000}s`)), AI_TIMEOUT_MS),
  );

  const result = await Promise.race([model.generateContent(prompt), timeoutPromise]);
  const text = result.response.text();

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const cleanJson = jsonMatch ? jsonMatch[0] : text;

    const parsed = JSON.parse(cleanJson) as AIAnalysisResult;
    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      summary: parsed.summary || "Analysis complete.",
      scan_mode: mode,
      threat_model: parsed.threat_model ?? {},
      attack_chains: Array.isArray(parsed.attack_chains) ? parsed.attack_chains : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    };
  } catch (e) {
    console.error("[ai] Response parse error:", e);
    return { issues: [], summary: "Analysis failed — could not parse response." };
  }
}

export function analyzeSecuritySweep(
  input: string,
  context: Omit<ScanContext, "triggerType">,
): Promise<AIAnalysisResult> {
  return analyzeCode(
    input,
    { ...context, triggerType: "security_sweep" },
    { mode: "security_sweep" },
  );
}

/**
 * Runs a cheap one-shot AI call to extract the security architecture of a repo
 * from its key auth files (middleware, lib/auth, etc.) and any developer-provided
 * .gitsentry/context.md. Returns a compact summary string that is stored in the
 * DB and injected into future scan prompts as trusted context.
 */
export async function discoverSecurityContext(
  files: {path: string; content: string}[],
  repoFullName: string,
): Promise<string> {
  if (!files.length) return "";

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json"},
  });

  // If a developer-provided context file exists, surface it first
  const customFile = files.find((f) => f.path === ".gitsentry/context.md");
  const authFiles = files.filter((f) => f.path !== ".gitsentry/context.md");

  const fileContents = authFiles
    .map((f) => `=== ${f.path} ===\n${f.content}`)
    .join("\n\n");

  const prompt = `You are analyzing a repository's security architecture to produce a brief summary for a security scanner.

Repository: ${repoFullName}

Examine these files and identify the patterns used for authentication, authorization, and rate limiting:

${fileContents || "(no standard auth files found)"}

Return ONLY valid JSON (no markdown):
{
  "auth_pattern": "<one sentence: how authentication works, naming the key function/middleware, e.g. 'getServerSession(authOptions) — returns null if unauthenticated'>",
  "ownership_check": "<one sentence: how resource ownership is verified, e.g. 'userCanAccessRepo(userId, orgId, resource.orgId) returns false → 403', or null if not found>",
  "rate_limiting": "<one sentence: how rate limiting or quota enforcement works, e.g. 'monthly quota via tryClaimScan() atomic DB claim', or null if not found>",
  "key_helpers": ["<function or middleware names that guard routes — list only names, not signatures>"]
}`;

  try {
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("discovery timed out")), 15_000),
      ),
    ]);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return customFile?.content ?? "";

    const parsed = JSON.parse(jsonMatch[0]) as {
      auth_pattern?: string;
      ownership_check?: string;
      rate_limiting?: string;
      key_helpers?: string[];
    };

    const lines: string[] = [];
    if (parsed.auth_pattern) lines.push(`- Auth: ${parsed.auth_pattern}`);
    if (parsed.ownership_check) lines.push(`- Ownership: ${parsed.ownership_check}`);
    if (parsed.rate_limiting) lines.push(`- Rate limiting: ${parsed.rate_limiting}`);
    if (parsed.key_helpers?.length) {
      lines.push(`- Key security helpers: ${parsed.key_helpers.join(", ")}`);
    }

    const discovered = lines.join("\n");
    if (customFile) {
      return `DEVELOPER-PROVIDED CONTEXT (.gitsentry/context.md):\n${customFile.content}\n\nDISCOVERED PATTERNS:\n${discovered}`;
    }
    return discovered;
  } catch (err) {
    console.warn("[ai] discoverSecurityContext failed:", (err as Error).message);
    return customFile?.content ?? "";
  }
}

function categoryList(categories: [string, string][]): string {
  return categories
    .map(([key, description], index) => `${index + 1}. ${key} — ${description}`)
    .join("\n");
}

function buildPrompt(input: string, context: ScanContext, mode: string): string {
  const isSweep = mode === "security_sweep";
  const inputLabel = isSweep
    ? "CODEBASE, DESIGN NOTES, OR SELECTED CONTEXT TO AUDIT"
    : "DIFF WITH CONTEXT (+ = added line, spaces = unchanged context — format: [+| ] L<num>: <code>)";

  const repoContextSection = context.repoSecurityContext
    ? `\nREPO SECURITY CONTEXT (auto-discovered from this codebase — treat as ground truth):
${context.repoSecurityContext}
When the above patterns are present, do NOT flag a finding that is already handled by them.
Examples: if ownership checks are documented, "fetch-then-check" is NOT an IDOR; if quota enforcement is documented, quota-based limits ARE rate limiting.\n`
    : "";

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
- You are seeing added lines (+) and surrounding unchanged context lines (spaces) from this PR.
- Focus on vulnerabilities introduced by the added lines.
- Read the full hunk context before flagging: if an auth check, ownership guard, or rate-limit call appears in the same function (even in unchanged lines), do NOT flag a finding based only on the fetch/action line.
- "fetch-then-check" is a valid authorization pattern: fetching a resource and then verifying ownership is NOT an IDOR if an ownership check follows in the same function.
- Quota or usage-based enforcement (monthly limits, trial slots) IS rate limiting for SaaS products — do not flag missing_rate_limit solely because there is no IP-based middleware.
- Prefer concrete, actionable findings over speculative architecture advice.
- Only report a broader risk when the added code itself creates a realistic exploit path.
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
${repoContextSection}
${scopeRules}

SECURITY CATEGORIES TO CHECK (in order of importance):
${categoryList(ALL_CATEGORIES)}

THREAT MODELING CHECKLIST:
- Attacker profiles: anonymous user, authenticated user, malicious insider, API consumer, compromised integration.
- Entry points: UI actions, API routes, webhooks, background jobs, database reads/writes, third-party callbacks.
- Trust boundaries: browser/server, server/database, GitHub/webhook, AI/provider, worker/queue, external services.
- Sensitive assets: credentials, tokens, PII, private repo code, scan findings, billing state, admin permissions.

${inputLabel}:
${input}

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
