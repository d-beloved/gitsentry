import type { AIProvider, GenerateRequest, GenerateResponse, JsonSchema } from "./types";
import { describeSchema, toStrictSchema } from "./schema";

// Any OpenAI-shaped /chat/completions host. Nothing branches on which host is
// configured: host differences are configuration (incl. extraBody), not inference.

// Strongest to weakest enforcement. Defaults to json_object, the only mode every
// host implements; a wrong stronger guess would fail every scan.
export type StructuredMode = "json_schema" | "tool_strict" | "json_object";

export interface OpenAICompatOptions {
  apiKey: string;
  baseURL: string;
  structuredMode?: StructuredMode;
  /** Routers only: endpoint slugs to pin routing to, most preferred first. */
  providerOrder?: string[];
  /** Routers only: whether routing may leave `providerOrder`. */
  allowFallbacks?: boolean;
  extraBody?: Record<string, unknown>;
  name?: string;
}

const CHAT_PATH = "/chat/completions";

export class OpenAICompatProvider implements AIProvider {
  readonly name: string;
  readonly structuredMode: StructuredMode;
  private opts: Required<Omit<OpenAICompatOptions, "name">>;

  constructor(options: OpenAICompatOptions) {
    this.opts = {
      apiKey: options.apiKey,
      baseURL: options.baseURL.replace(/\/+$/, ""),
      structuredMode: options.structuredMode ?? "json_object",
      providerOrder: options.providerOrder ?? [],
      allowFallbacks: options.allowFallbacks ?? true,
      extraBody: options.extraBody ?? {},
    };
    this.name = options.name ?? hostOf(options.baseURL);
    this.structuredMode = this.opts.structuredMode;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const mode = this.opts.structuredMode;
    const schema = req.schema ? toStrictSchema(req.schema) : undefined;
    const schemaName = req.schemaName ?? "response";

    // In json_object mode the schema prose is constant, so it goes in the cached
    // prefix, not past the cache breakpoint.
    const system =
      schema && mode === "json_object"
        ? [req.system, describeSchema(schema)].filter(Boolean).join("\n\n")
        : req.system;

    // Extra bodies go first so computed fields always win; per-call knobs
    // override the provider's global ones key by key.
    const body: Record<string, unknown> = {
      ...this.opts.extraBody,
      ...req.extraBody,
      model: req.model,
      messages: buildMessages(system, req.prompt),
    };

    if (schema) {
      if (mode === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema },
        };
      } else if (mode === "tool_strict") {
        body.tools = [
          {
            type: "function",
            function: { name: schemaName, strict: true, parameters: schema },
          },
        ];
        // Otherwise the model may answer in prose and skip the schema.
        body.tool_choice = { type: "function", function: { name: schemaName } };
      } else {
        body.response_format = { type: "json_object" };
      }
    }

    // Only sent when pinned: non-aggregator hosts 400 on the unknown key.
    if (this.opts.providerOrder.length) {
      body.provider = {
        order: this.opts.providerOrder,
        allow_fallbacks: this.opts.allowFallbacks,
        // Never route to an endpoint that would silently drop response_format.
        require_parameters: true,
        // Customer source code: exclude endpoints that retain prompts.
        data_collection: "deny",
      };
    }

    const res = await fetch(`${this.opts.baseURL}${CHAT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`[ai] ${this.name} returned ${res.status}: ${detail.slice(0, 500)}`);
    }

    const json = (await res.json()) as ChatCompletion;
    return {
      text: extractText(json, mode),
      // Includes the cached slice, consistent with the other providers' tokensIn.
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
      // Hosts report cache hits nested or flat; read both.
      cachedTokens:
        json.usage?.prompt_tokens_details?.cached_tokens ??
        json.usage?.prompt_cache_hit_tokens ??
        0,
      model: json.model || req.model,
    };
  }
}

// The cache_control breakpoint enables prefix caching on hosts that don't cache
// implicitly; hosts that do ignore it.
function buildMessages(system: string | undefined, prompt: string) {
  const messages: unknown[] = [];
  if (system) {
    messages.push({
      role: "system",
      content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

// Falls back to content so a host that ignored tool_choice still yields its answer.
function extractText(json: ChatCompletion, mode: StructuredMode): string {
  const message = json.choices?.[0]?.message;
  if (mode === "tool_strict") {
    const args = message?.tool_calls?.[0]?.function?.arguments;
    if (args) return args;
  }
  return message?.content ?? "";
}

function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).hostname.replace(/^api\./, "").split(".")[0];
  } catch {
    return "openai-compat";
  }
}

interface ChatCompletion {
  model?: string;
  choices?: {
    message?: {
      content?: string;
      tool_calls?: { function?: { arguments?: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
}
