/**
 * Project classifier — prompt builder and response parser.
 *
 * No Gemini dependency here: each app (backend, web) calls its own Gemini
 * client with the prompt returned by buildClassifierPrompt() and passes the
 * raw text to parseClassificationResponse().
 */

import type { ProjectClassification, ProjectType, DeploymentContext } from "./scanner-rules";

const VALID_PROJECT_TYPES = new Set<ProjectType>([
  "library", "framework_plugin", "cli_tool", "api_service",
  "frontend_app", "standalone_app", "monorepo", "unknown",
]);

const VALID_DEPLOYMENT_CONTEXTS = new Set<DeploymentContext>([
  "deployed_by_author", "consumed_by_others",
]);

/**
 * Build the classification prompt.
 *
 * @param repoFullName  "owner/repo"
 * @param filePaths     All file paths available (from diff, tree listing, or fetched files)
 * @param manifestContent  Raw content of a manifest file (package.json, Gemfile, Cargo.toml, etc.) if available
 */
export function buildClassifierPrompt(
  repoFullName: string,
  filePaths: string[],
  manifestContent?: string,
): string {
  const pathList = filePaths.slice(0, 150).join("\n");
  const manifestSection = manifestContent
    ? `\nMANIFEST FILE CONTENT (package.json / Gemfile / Cargo.toml / etc.):\n${manifestContent.slice(0, 2000)}`
    : "";

  return `You are classifying a software repository so a security scanner can apply the correct rules.
This repo could be written in any language or framework. Use your knowledge of software ecosystems, build systems, package managers, and project conventions across all languages to make the call.

Repository: ${repoFullName}

FILE PATHS (sample from repo tree or diff):
${pathList}
${manifestSection}

TASK: Determine the following three things.

1. project_type — pick the single best fit:
   - library          : code published for other developers to import/install/depend on
   - framework_plugin : code that plugs into or extends a host framework or app (the host owns auth/routing)
   - cli_tool         : a program invoked from the command line or CI
   - api_service      : a backend service the author deploys and operates
   - frontend_app     : client-side only UI with no server-side business logic
   - standalone_app   : a full-stack or server-rendered app the author deploys
   - monorepo         : multiple independently deployable packages or apps in one repo
   - unknown          : signals are too ambiguous to decide

   Use whatever signals are available — manifest files, directory structure, entry-point names, framework conventions, build tool config, or any ecosystem-specific pattern you recognise. Apply this reasoning across any programming language or ecosystem.

2. deployment_context:
   - deployed_by_author  : the author runs or hosts it
   - consumed_by_others  : other developers install, import, or mount it

3. test_paths: path prefixes that are test scaffolding (dummy apps, fixtures, mocks, support helpers) which should be excluded from security scanning. Use your knowledge of each ecosystem's test conventions. Return [] if none found.

Return ONLY valid JSON (no markdown fences, no explanation):
{
  "project_type": "<one of the types above>",
  "deployment_context": "deployed_by_author" | "consumed_by_others",
  "test_paths": ["<path prefix>"],
  "confidence": "high" | "low",
  "reasoning": "<one sentence explaining the key signal you used>"
}`;
}

/**
 * Parse the raw Gemini response text into a ProjectClassification.
 * Returns a safe "unknown" fallback on any parse failure.
 */
export function parseClassificationResponse(text: string): ProjectClassification {
  const fallback: ProjectClassification = {
    project_type: "unknown",
    deployment_context: "deployed_by_author",
    test_paths: [],
    confidence: "low",
    reasoning: "Classification failed — full rules applied.",
  };

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]) as Partial<{
      project_type: string;
      deployment_context: string;
      test_paths: unknown;
      confidence: string;
      reasoning: string;
    }>;

    const project_type = VALID_PROJECT_TYPES.has(parsed.project_type as ProjectType)
      ? (parsed.project_type as ProjectType)
      : "unknown";

    const deployment_context = VALID_DEPLOYMENT_CONTEXTS.has(parsed.deployment_context as DeploymentContext)
      ? (parsed.deployment_context as DeploymentContext)
      : "deployed_by_author";

    const test_paths = Array.isArray(parsed.test_paths)
      ? parsed.test_paths.filter((p): p is string => typeof p === "string")
      : [];

    return {
      project_type,
      deployment_context,
      test_paths,
      confidence: parsed.confidence === "high" ? "high" : "low",
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    return fallback;
  }
}

/**
 * Extract file paths from a unified diff string.
 * Used by the backend scanner where the diff is already available.
 */
export function extractPathsFromDiff(diff: string): string[] {
  const matches = [...diff.matchAll(/^diff --git a\/(.+) b\/.+$/gm)];
  return [...new Set(matches.map((m) => m[1]))];
}
