/**
 * Context-aware security scanning rules.
 *
 * HOW TO ADD A RULE
 * -----------------
 * Found a false positive?
 *   1. Identify the project type that triggers it.
 *   2. Add the category to skip_categories (never flag) or deprioritize_categories (flag only with strong evidence).
 *   3. Extend extra_instructions with a sentence explaining the constraint.
 *   4. Do NOT patch the AI prompt directly.
 *
 * Found a new project type signal?
 *   1. Add its path prefix to TEST_PATH_PREFIXES or a new entry in PROJECT_TYPE_RULES.
 */

export type ProjectType =
  | "library"          // npm package, gem, pip/pypi, composer, crate, etc.
  | "framework_plugin" // Rails engine, Express middleware, WP plugin, etc.
  | "cli_tool"         // Command-line tools run locally or in CI
  | "api_service"      // Backend API / microservice the author deploys
  | "frontend_app"     // Client-side only (React, Vue, Svelte, etc.)
  | "standalone_app"   // Full-stack app the author deploys (Rails, Django, Laravel, Next.js)
  | "monorepo"         // Multiple packages/apps in one repo
  | "unknown";         // Could not determine — full rules apply conservatively

export type DeploymentContext =
  | "deployed_by_author"  // Author runs/operates it — full security responsibility
  | "consumed_by_others"; // Others install, import, or mount it — consumer owns some surface

export interface ProjectClassification {
  project_type: ProjectType;
  deployment_context: DeploymentContext;
  /** Path prefixes identifying test scaffolding to exclude from scanning. */
  test_paths: string[];
  confidence: "high" | "low";
  reasoning: string;
}

export interface ProjectTypeRules {
  description: string;
  /** Categories to never flag for this project type. */
  skip_categories: string[];
  /** Categories to flag only with very clear, concrete evidence. */
  deprioritize_categories: string[];
  /** Extra instructions injected into the AI prompt for this project type. */
  extra_instructions: string;
}

// ─── Per-project-type rules ───────────────────────────────────────────────────

export const PROJECT_TYPE_RULES: Record<ProjectType, ProjectTypeRules> = {
  library: {
    description: "A reusable package published for others to consume (npm, gem, pip, composer, crate, etc.)",
    skip_categories: [
      "missing_auth",
      "missing_rate_limit",
      "csrf",
      "cors_misconfiguration",
      "security_headers_missing",
      "weak_session_management",
    ],
    deprioritize_categories: [
      "idor",
      "business_logic_abuse",
      "insecure_storage",
    ],
    extra_instructions:
      "This is a reusable library or package. Authentication, rate limiting, CSRF, CORS, and security headers " +
      "are the consumer application's responsibility — do NOT flag these. " +
      "Focus only on issues the library code itself introduces: hardcoded secrets, unsafe deserialization, " +
      "command injection, path traversal, or unsafe API defaults that ship to consumers.",
  },

  framework_plugin: {
    description: "A plugin, engine, or middleware mounted by a host framework (Rails engine, Express middleware, WP plugin, etc.)",
    skip_categories: [
      "missing_auth",
      "missing_rate_limit",
      "csrf",
    ],
    deprioritize_categories: [
      "cors_misconfiguration",
      "security_headers_missing",
    ],
    extra_instructions:
      "This is a framework plugin or mountable engine. Authentication and rate limiting belong to the host application, " +
      "not the plugin. Only flag issues the plugin itself introduces regardless of how it is mounted — " +
      "e.g. hardcoded credentials, unsafe file operations, or injection in plugin-managed code.",
  },

  cli_tool: {
    description: "A command-line tool run locally by developers or in CI pipelines",
    skip_categories: [
      "csrf",
      "cors_misconfiguration",
      "security_headers_missing",
      "xss",
      "missing_rate_limit",
      "weak_session_management",
    ],
    deprioritize_categories: [
      "missing_auth",
    ],
    extra_instructions:
      "This is a CLI tool. CSRF, CORS, XSS, session management, and web security headers do not apply. " +
      "Focus on: secrets embedded in code or config files, command injection, path traversal, " +
      "unsafe temp file handling, insecure use of environment variables, and supply-chain risks in dependencies.",
  },

  api_service: {
    description: "A backend API or microservice the author deploys and operates",
    skip_categories: [],
    deprioritize_categories: [],
    extra_instructions:
      "This is a deployed backend API service. Apply full security rules. " +
      "Pay special attention to auth on every endpoint, IDOR, injection vulnerabilities, " +
      "rate limiting, and trust-boundary violations between internal services.",
  },

  frontend_app: {
    description: "A client-side web application (React, Vue, Angular, Svelte, etc.)",
    skip_categories: [
      "sql_injection",
      "nosql_injection",
      "ssrf",
      "command_injection",
      "path_traversal",
      "insecure_file_upload",
      "cloud_misconfiguration",
    ],
    deprioritize_categories: [
      "missing_auth",
      "missing_rate_limit",
    ],
    extra_instructions:
      "This is a frontend-only application. Server-side injection categories " +
      "(SQL/NoSQL injection, SSRF, command injection, path traversal) do not apply to client-side code. " +
      "Focus on: XSS, API keys or tokens bundled into client code, insecure localStorage usage, " +
      "sensitive data exposure, and unsafe third-party script inclusion.",
  },

  standalone_app: {
    description: "A full-stack application the author deploys (Rails, Django, Laravel, Next.js, etc.)",
    skip_categories: [],
    deprioritize_categories: [],
    extra_instructions:
      "This is a full-stack standalone application. Apply the full rule set across frontend, backend, and database layers.",
  },

  monorepo: {
    description: "A monorepo containing multiple packages or applications with different deployment contexts",
    skip_categories: [],
    deprioritize_categories: [],
    extra_instructions:
      "This is a monorepo. When the diff or code touches a library/package subdirectory, treat it with library-level rules " +
      "(auth, rate-limit, CSRF are consumer responsibilities). " +
      "When touching an application or service subdirectory, apply full rules. " +
      "Note the deployment context per file path in your findings.",
  },

  unknown: {
    description: "Project type could not be determined — applying conservative full rule set",
    skip_categories: [],
    deprioritize_categories: [],
    extra_instructions:
      "Project type is unclear. Apply full security rules conservatively and note any assumptions made.",
  },
};

// ─── Test scaffolding path prefixes ──────────────────────────────────────────
// Findings in files under these prefixes are excluded from results.
// Add a new entry here when a false positive originates from test scaffolding.

export const TEST_PATH_PREFIXES: string[] = [
  "spec/dummy/",
  "spec/fixtures/",
  "spec/support/",
  "test/dummy/",
  "test/fixtures/",
  "test/support/",
  "tests/fixtures/",
  "tests/support/",
  "__tests__/",
  "__mocks__/",
  "e2e/fixtures/",
  "cypress/fixtures/",
  "playwright/fixtures/",
  ".storybook/",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function isTestScaffolding(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return TEST_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
