// Provider-agnostic AI interface: callers describe what to generate, a provider decides how.

/** Plain JSON Schema; `nullable` and `format: "enum"` are normalised by toStrictSchema(). */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  format?: string;
  enum?: string[];
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: JsonSchema[];
}

export interface GenerateRequest {
  model: string;
  /** Stable prefix, kept separate so providers can cache it. */
  system?: string;
  prompt: string;
  schema?: JsonSchema;
  /** Identifies the schema to providers that require a name (json_schema, tools). */
  schemaName?: string;
  /** Forwarded so an abandoned call also releases its socket. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Per-call host knobs, shallow-merged over the provider's extra body. */
  extraBody?: Record<string, unknown>;
}

export interface GenerateResponse {
  text: string;
  /** Whole prompt, cached tokens included. */
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  /** Tokens written to cache, also inside tokensIn; only some providers report it. */
  cacheWriteTokens?: number;
  model: string;
}

export interface AIProvider {
  /** Label for logs and token-accounting rows. */
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}
