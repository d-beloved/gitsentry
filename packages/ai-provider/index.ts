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
    providerOrder: (aiEnv("PROVIDER_ORDER") ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
    allowFallbacks: process.env.AI_ALLOW_FALLBACKS !== "off",
  });
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
