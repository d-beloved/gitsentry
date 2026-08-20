import type { AIProvider } from "./types";
import { GeminiProvider } from "./gemini";
import { OpenAICompatProvider, type StructuredMode } from "./openaiCompat";
import { aiEnv, requireAiEnv } from "./env";

export type { AIProvider, GenerateRequest, GenerateResponse, JsonSchema } from "./types";
export type { StructuredMode } from "./openaiCompat";
export { GeminiProvider } from "./gemini";
export { OpenAICompatProvider } from "./openaiCompat";
export { toStrictSchema, describeSchema } from "./schema";
export { aiEnv, requireAiEnv } from "./env";

/**
 * Builds the provider from env.
 *
 *   AI_API_KEY          — required, whichever vendor is in use
 *   AI_BASE_URL         — set it and you get the OpenAI-compatible provider;
 *                         leave it unset and you get Gemini. This single var is
 *                         the whole vendor switch.
 *   AI_STRUCTURED_MODE  — json_schema | tool_strict | json_object. Defaults to
 *                         json_object, the only mode every host implements; see
 *                         openaiCompat.ts for when to raise it.
 *   AI_PROVIDER_ORDER   — comma-separated endpoint slugs, preferred first. Only
 *                         meaningful on aggregators that route between hosts;
 *                         leave unset for an endpoint that serves its own model.
 *   AI_ALLOW_FALLBACKS  — "off" to fail rather than route outside the pin.
 *   AI_EXTRA_BODY       — JSON object merged into every request body, for host
 *                         knobs this code does not model. The main use is
 *                         reasoning: hybrid models think by default, which is
 *                         the difference between a scan that answers in seconds
 *                         and one that spends minutes before its first token.
 *                         Consult the host's docs for the spelling.
 *   AI_<ROLE>_EXTRA_BODY — same, for one kind of call, merged over the global
 *                         one. See extraBodyFor().
 *
 * Pointing at a single-model endpoint:
 *   AI_BASE_URL=https://host.example/v1
 *   AI_SCAN_MODEL=<model id that host publishes>
 *
 * Pointing at an aggregator, pinned to named endpoints:
 *   AI_BASE_URL=https://aggregator.example/api/v1
 *   AI_SCAN_MODEL=<vendor>/<model>
 *   AI_PROVIDER_ORDER=<slug>,<slug>
 */
export function createProvider(): AIProvider {
  const apiKey = requireAiEnv("API_KEY");
  const baseURL = aiEnv("BASE_URL");

  if (!baseURL) return new GeminiProvider(apiKey);

  const mode = aiEnv("STRUCTURED_MODE") as StructuredMode | undefined;
  if (mode && !["json_schema", "tool_strict", "json_object"].includes(mode)) {
    throw new Error(
      `AI_STRUCTURED_MODE must be json_schema, tool_strict, or json_object — got "${mode}"`,
    );
  }

  return new OpenAICompatProvider({
    apiKey,
    baseURL,
    structuredMode: mode,
    extraBody: parseExtraBody(aiEnv("EXTRA_BODY")),
    providerOrder: (aiEnv("PROVIDER_ORDER") ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
    allowFallbacks: process.env.AI_ALLOW_FALLBACKS !== "off",
  });
}

/**
 * Fields createProvider() computes from other env vars, so an extra body that
 * also set them would be a second source of truth that loses. Rejected by name
 * rather than merged and overwritten, because the whole reason to reach for
 * AI_EXTRA_BODY is that you cannot see the request being built.
 */
const RESERVED_BODY_KEYS: Record<string, string> = {
  model: "AI_SCAN_MODEL / AI_SWEEP_MODEL / AI_DISCOVERY_MODEL",
  messages: "the prompt itself",
  response_format: "AI_STRUCTURED_MODE",
  tools: "AI_STRUCTURED_MODE",
  tool_choice: "AI_STRUCTURED_MODE",
  provider: "AI_PROVIDER_ORDER / AI_ALLOW_FALLBACKS",
};

/**
 * Parses an extra-body env var, throwing on anything it cannot honour exactly.
 *
 * Every failure mode here is otherwise invisible: a stray quote that drops a
 * "thinking: disabled" still returns findings, just slowly and at several times
 * the token cost, with nothing in the logs to say the setting never applied.
 * Boot is the only place that mistake is cheap to notice — which is why callers
 * resolve these at module load rather than per call.
 *
 * @param raw  the env value
 * @param varName  which var it came from, so the error says what to go fix
 */
export function parseExtraBody(
  raw: string | undefined,
  varName = "AI_EXTRA_BODY",
): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Far and away the most common way this breaks: the value was set through a
    // shell, which strips the double quotes JSON requires — `{"a":1}` arrives as
    // `{a:1}`. Worth naming, because the message you get otherwise ("Expected
    // property name") reads like the JSON was written wrong rather than eaten.
    const looksUnquoted = raw.includes("{") && !raw.includes('"');
    throw new Error(
      `${varName} is not valid JSON: ${(err as Error).message}` +
        (looksUnquoted
          ? ` — the value has no double quotes, which usually means a shell ate them.` +
            ` Wrap it in single quotes: ${varName}='{"key":"value"}'`
          : ""),
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${varName} must be a JSON object, e.g. {"thinking":{"type":"disabled"}}`,
    );
  }

  const clash = Object.keys(parsed).find((key) => key in RESERVED_BODY_KEYS);
  if (clash) {
    throw new Error(
      `${varName} may not set "${clash}" — that field is owned by ${RESERVED_BODY_KEYS[clash]}`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Per-role host knobs, read from `AI_<ROLE>_EXTRA_BODY`.
 *
 * The roles are the ones the model and timeout vars already name — SCAN, SWEEP,
 * DISCOVERY, VERIFY — because they are the axis along which these calls
 * genuinely differ. Reasoning is the setting that makes that concrete: the
 * sweep is an adversarial read of a whole repo and wants every bit of it, while
 * discovery is a bounded JSON answer where thinking is pure latency and cost.
 * A single process-wide value has to be wrong for one of them.
 *
 * Returns only this role's fields; the global AI_EXTRA_BODY is already baked
 * into the provider and these merge over it, so a role names just what it
 * changes rather than restating the default.
 */
export function extraBodyFor(role: string): Record<string, unknown> | undefined {
  const varName = `AI_${role}_EXTRA_BODY`;
  return parseExtraBody(aiEnv(`${role}_EXTRA_BODY`), varName);
}

/**
 * Process-wide provider.
 *
 * Lazy because construction reads env, and importing this module must not throw
 * in tests that never make a call. eval/run.ts overrides it per run to compare
 * two vendors against the same prompts.
 */
let cached: AIProvider | undefined;

export function getProvider(): AIProvider {
  if (!cached) cached = createProvider();
  return cached;
}

/** Swaps the provider — for eval runs and tests. Pass undefined to reset. */
export function setProvider(provider: AIProvider | undefined): void {
  cached = provider;
}
