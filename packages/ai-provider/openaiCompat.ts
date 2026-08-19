import type { AIProvider, GenerateRequest, GenerateResponse, JsonSchema } from "./types";
import { describeSchema, toStrictSchema } from "./schema";

/**
 * Provider for any OpenAI-shaped /chat/completions endpoint.
 *
 * One implementation covers every host that speaks that dialect, because the
 * only thing separating them is a base URL and how seriously they take a
 * schema. Written against fetch rather than the `openai` SDK: the surface used
 * here is one POST, and both apps already run on a runtime with fetch built in.
 *
 * Nothing here branches on which host is configured. Endpoints differ in ways
 * that are not derivable from a URL — whether strict schemas are enforced,
 * whether they are served from a different path, how a cache hit is reported —
 * so those are configuration, not inference. A host table baked into the code
 * would be stale the week after it was written.
 */

/**
 * How the provider asks for structured output, in descending order of
 * enforcement:
 *
 *   json_schema — response_format with strict:true. Grammar-constrained, and
 *     the right choice on any endpoint that genuinely implements it.
 *   tool_strict — a single forced function call with strict:true. The fallback
 *     for hosts that enforce schemas on the tool-calling path but not on
 *     response_format. Some serve it from a different base path; point
 *     AI_BASE_URL at that path directly if so.
 *   json_object — valid JSON, unvalidated shape, schema described in-prompt.
 *
 * Defaults to json_object because it is the only one of the three that every
 * OpenAI-compatible host implements, and the failure mode of guessing high is a
 * hard error on every scan. Opt up with AI_STRUCTURED_MODE once the endpoint is
 * confirmed to enforce the stronger mode — the eval is there to confirm it.
 */
export type StructuredMode = "json_schema" | "tool_strict" | "json_object";

export interface OpenAICompatOptions {
  apiKey: string;
  /** Full base URL of the endpoint, e.g. https://host.example/v1 */
  baseURL: string;
  structuredMode?: StructuredMode;
  /** Endpoint slugs to pin routing to, most preferred first. Routers only. */
  providerOrder?: string[];
  /** When true, routing may leave `providerOrder`. Routers only. */
  allowFallbacks?: boolean;
  /** Short label for logs and token rows. Defaults to the base URL's host. */
  name?: string;
}

const CHAT_PATH = "/chat/completions";

export class OpenAICompatProvider implements AIProvider {
  readonly name: string;
  /** Exposed so the eval harness can record which structured-output path a run
   *  actually took, since the default is not visible in env alone. */
  readonly structuredMode: StructuredMode;
  private opts: Required<Omit<OpenAICompatOptions, "name">>;

  constructor(options: OpenAICompatOptions) {
    this.opts = {
      apiKey: options.apiKey,
      baseURL: options.baseURL.replace(/\/+$/, ""),
      structuredMode: options.structuredMode ?? "json_object",
      providerOrder: options.providerOrder ?? [],
      allowFallbacks: options.allowFallbacks ?? true,
    };
    this.name = options.name ?? hostOf(options.baseURL);
    this.structuredMode = this.opts.structuredMode;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const mode = this.opts.structuredMode;
    const schema = req.schema ? toStrictSchema(req.schema) : undefined;
    const schemaName = req.schemaName ?? "response";

    // In json_object mode the schema only exists as prose, so it belongs in the
    // cached prefix rather than the variable tail — it repeats verbatim on every
    // call, and appending it to the tail would push a large constant block past
    // the cache breakpoint on every request.
    const system =
      schema && mode === "json_object"
        ? [req.system, describeSchema(schema)].filter(Boolean).join("\n\n")
        : req.system;

    const body: Record<string, unknown> = {
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
        // Without this the model may answer in prose instead of calling the
        // function, which defeats the point of using tools for schema enforcement.
        body.tool_choice = { type: "function", function: { name: schemaName } };
      } else {
        body.response_format = { type: "json_object" };
      }
    }

    // Routing controls are understood by aggregators that front several
    // endpoints, and rejected as unknown keys by hosts that serve their own
    // model — so they are sent only when a pin was actually configured.
    if (this.opts.providerOrder.length) {
      body.provider = {
        order: this.opts.providerOrder,
        allow_fallbacks: this.opts.allowFallbacks,
        // Never route to an endpoint that would silently drop response_format
        // and hand back unvalidated prose.
        require_parameters: true,
        // Customer source code — exclude endpoints that retain prompts.
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
      // prompt_tokens already includes the cached slice, matching Gemini's
      // promptTokenCount — so cost maths stays identical across providers.
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
      // Two spellings in the wild: nested under prompt_tokens_details, or flat.
      // Reading both means a host swap does not silently zero the cache column.
      cachedTokens:
        json.usage?.prompt_tokens_details?.cached_tokens ??
        json.usage?.prompt_cache_hit_tokens ??
        0,
      model: json.model || req.model,
    };
  }
}

/**
 * Builds the message array, marking the stable prefix as cacheable.
 *
 * The `cache_control` breakpoint is what makes prefix caching work on hosts
 * that do not cache implicitly, which is most of them. Hosts that do cache
 * automatically ignore the marker, so it is safe to always send and keeps the
 * routed path one env var away rather than one refactor away.
 */
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

/**
 * Pulls the payload out of whichever field the chosen mode fills.
 *
 * tool_strict puts it in function.arguments; the response_format modes put it
 * in content. Falls back across both so a provider that quietly ignored
 * tool_choice still yields its answer instead of an empty string.
 */
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
