import type { AIProvider } from "./types";
import { GeminiProvider } from "./gemini";
import { OpenAICompatProvider, type StructuredMode } from "./openaiCompat";
import { AnthropicProvider } from "./anthropic";
import {
  activeVendor,
  envFor,
  envName,
  requireEnvFor,
  type Transport,
  type Vendor,
} from "./env";

export type { AIProvider, GenerateRequest, GenerateResponse, JsonSchema } from "./types";
export type { StructuredMode } from "./openaiCompat";
export { GeminiProvider } from "./gemini";
export { OpenAICompatProvider } from "./openaiCompat";
export { toStrictSchema, describeSchema } from "./schema";
export { AnthropicProvider } from "./anthropic";
export {
  aiEnv,
  requireAiEnv,
  envFor,
  requireEnvFor,
  envName,
  VENDORS,
  isVendor,
  activeVendor,
  setActiveVendor,
  configuredVendors,
  type Vendor,
} from "./env";

/**
 * Builds the provider for a vendor from env. Unprefixed config: AI_BASE_URL set means
 * OpenAI-compatible, unset means Gemini. Named vendors use their own transport.
 */
export function createProvider(vendor: Vendor | null = activeVendor()): AIProvider {
  const apiKey = requireEnvFor(vendor, "API_KEY");
  const extraBody = parseExtraBody(envFor(vendor, "EXTRA_BODY"), envName(vendor, "EXTRA_BODY"));

  const transport = transportFor(vendor);
  if (transport === "anthropic") {
    return new AnthropicProvider({ apiKey, extraBody, baseURL: envFor(vendor, "BASE_URL") });
  }
  if (transport === "gemini") return new GeminiProvider(apiKey);

  return new OpenAICompatProvider({
    apiKey,
    baseURL: requireEnvFor(vendor, "BASE_URL"),
    structuredMode: structuredModeFor(vendor),
    extraBody,
    providerOrder: (envFor(vendor, "PROVIDER_ORDER") ?? "")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean),
    allowFallbacks: envFor(vendor, "ALLOW_FALLBACKS") !== "off",
  });
}

function transportFor(vendor: Vendor | null): Transport {
  if (vendor) return vendor;
  return envFor(null, "BASE_URL") ? "openai_compat" : "gemini";
}

function structuredModeFor(vendor: Vendor | null): StructuredMode | undefined {
  const mode = envFor(vendor, "STRUCTURED_MODE") as StructuredMode | undefined;
  if (mode && !["json_schema", "tool_strict", "json_object"].includes(mode)) {
    throw new Error(
      `${envName(vendor, "STRUCTURED_MODE")} must be json_schema, tool_strict, or json_object — got "${mode}"`,
    );
  }
  return mode;
}

/** Validates a vendor's config without a call; run at boot and before a runtime switch. */
export function assertVendorConfig(
  vendor: Vendor | null,
  { models = [], roles = [] }: { models?: string[]; roles?: string[] } = {},
): void {
  requireEnvFor(vendor, "API_KEY");
  if (transportFor(vendor) === "openai_compat") requireEnvFor(vendor, "BASE_URL");
  structuredModeFor(vendor);
  for (const suffix of models) requireEnvFor(vendor, suffix);
  parseExtraBody(envFor(vendor, "EXTRA_BODY"), envName(vendor, "EXTRA_BODY"));
  for (const role of roles) extraBodyFor(role, vendor);
}

// Fields the provider sets itself; an extra body may not override them.
const RESERVED_BODY_KEYS: Record<string, string> = {
  model: "AI_SCAN_MODEL / AI_SWEEP_MODEL / AI_DISCOVERY_MODEL",
  messages: "the prompt itself",
  response_format: "AI_STRUCTURED_MODE",
  tools: "AI_STRUCTURED_MODE",
  tool_choice: "AI_STRUCTURED_MODE",
  provider: "AI_PROVIDER_ORDER / AI_ALLOW_FALLBACKS",
  system: "the prompt itself",
  stream: "the provider, which always streams or never does",
  betas: "the provider",
};

/** Parses an extra-body env var, throwing on anything it can't apply exactly. */
export function parseExtraBody(
  raw: string | undefined,
  varName = "AI_EXTRA_BODY",
): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A shell strips the quotes JSON needs, so `{"a":1}` arrives as `{a:1}`.
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

/** AI_<ROLE>_EXTRA_BODY, merged over the global AI_EXTRA_BODY by the provider. */
export function extraBodyFor(
  role: string,
  vendor: Vendor | null = activeVendor(),
): Record<string, unknown> | undefined {
  const suffix = `${role}_EXTRA_BODY`;
  return parseExtraBody(envFor(vendor, suffix), envName(vendor, suffix));
}

// Built lazily so importing never throws; one instance per vendor.
const cache = new Map<Vendor | null, AIProvider>();
let override: AIProvider | undefined;

export function getProvider(vendor: Vendor | null = activeVendor()): AIProvider {
  if (override) return override;
  let provider = cache.get(vendor);
  if (!provider) {
    provider = createProvider(vendor);
    cache.set(vendor, provider);
  }
  return provider;
}

/** Pins one provider regardless of vendor, for eval and tests. undefined restores env-built ones. */
export function setProvider(provider: AIProvider | undefined): void {
  override = provider;
  cache.clear();
}
