/**
 * Provider-agnostic AI interface.
 *
 * GitSentry was bound to one vendor's SDK in four places (ai.ts, verifier.ts,
 * outreach.ts, social.ts), which made the model look like a fixed property of
 * the app rather than a setting. This module is the seam: callers describe
 * *what* they want generated — prompt, schema, budget — and a provider decides
 * how to ask for it. Swapping models becomes an env change, and eval/run.ts can
 * point the same prompts at two vendors to compare them.
 */

/**
 * Plain JSON Schema, deliberately not a vendor type.
 *
 * Gemini's `SchemaType` enum members are the lowercase strings JSON Schema
 * already uses ("object", "string", …), so one literal satisfies both worlds —
 * with two exceptions this type keeps room for: `nullable` is an OpenAPI-ism
 * Gemini accepts but strict JSON Schema does not, and Gemini spells enums
 * `{type: "string", format: "enum", enum: [...]}`. `toStrictSchema()` in
 * ./schema.ts normalises both away for providers that validate properly.
 */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  /** Gemini writes `format: "enum"` alongside `enum`; harmless elsewhere. */
  format?: string;
  enum?: string[];
  /** OpenAPI-style optionality. Converted to `anyOf: [T, null]` for strict mode. */
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: JsonSchema[];
}

export interface GenerateRequest {
  /** Model identifier, passed through verbatim. */
  model: string;
  /**
   * Stable instruction prefix — rubric, categories, output contract.
   *
   * Split from `prompt` because it is the half that repeats across every call,
   * which is exactly what prompt caching bills at a discount. Providers that
   * cache implicitly benefit from it sitting first; the rest need an explicit
   * breakpoint, which `openaiCompat` attaches here. Commit
   * 0e267bb reordered prompts for precisely this reason — this field is where
   * that intent now lives, rather than in the ordering of a concatenated string.
   */
  system?: string;
  /** Variable tail — the diff, the findings, the repo under review. */
  prompt: string;
  /** When set, the response is constrained to this shape. */
  schema?: JsonSchema;
  /** Identifies the schema to providers that require a name (json_schema, tools). */
  schemaName?: string;
  /**
   * Forwarded to the underlying transport so an abandoned call also releases
   * its socket. See withAIDeadline() for why racing a promise is not enough.
   */
  signal?: AbortSignal;
  /** Advisory per-request budget, handed to SDKs that accept one. */
  timeoutMs?: number;
}

export interface GenerateResponse {
  /** Raw model text. JSON parsing stays with the caller, which owns the shape. */
  text: string;
  /**
   * Prompt tokens. Both vendors count cached tokens inside this total, so it
   * stays comparable across providers; `cachedTokens` is the discounted slice
   * of it, not an addition to it.
   */
  tokensIn: number;
  tokensOut: number;
  /** Prompt tokens served from cache. 0 when the provider does not report it. */
  cachedTokens: number;
  /** Echoed back so callers record what actually ran, not what they asked for. */
  model: string;
}

export interface AIProvider {
  /** Short label for logs and token-accounting rows, e.g. "gemini". */
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}
