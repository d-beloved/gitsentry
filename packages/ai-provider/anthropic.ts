import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, GenerateRequest, GenerateResponse } from "./types";
import { toStrictSchema } from "./schema";

// Native Messages API: the OpenAI-compatible shim drops strict structured output and cache breakpoints.

// Thinking tokens count against this; a response cut off mid-JSON is useless.
const DEFAULT_MAX_TOKENS = 32_000;

// Retries on a substitute model when the requested one declines, instead of failing the scan.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicOptions {
  apiKey: string;
  extraBody?: Record<string, unknown>;
  baseURL?: string;
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private extraBody: Record<string, unknown>;

  constructor(options: AnthropicOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
    this.extraBody = options.extraBody ?? {};
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const extra = { ...this.extraBody, ...req.extraBody };

    // Merged one level deep so an effort set in the extra body keeps the schema.
    const outputConfig = {
      ...(extra.output_config as Record<string, unknown> | undefined),
      ...(req.schema
        ? { format: { type: "json_schema", schema: toStrictSchema(req.schema) } }
        : {}),
    };

    const params = {
      max_tokens: DEFAULT_MAX_TOKENS,
      fallbacks: "default",
      ...extra,
      model: req.model,
      ...(req.system
        ? { system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] }
        : {}),
      messages: [{ role: "user", content: req.prompt }],
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      betas: [FALLBACK_BETA],
    } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

    // Streamed because the SDK refuses non-streaming calls with a large max_tokens.
    const message = await this.client.beta.messages
      .stream(params, {
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
      })
      .finalMessage();

    // A refusal or truncation must throw: an empty answer would read as a clean scan.
    if (message.stop_reason === "refusal") {
      const d = message.stop_details;
      throw new Error(
        `[ai] anthropic declined the request (${d?.category ?? "uncategorised"})` +
          (d?.explanation ? `: ${d.explanation}` : ""),
      );
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error(
        `[ai] anthropic hit max_tokens (${params.max_tokens}) before finishing — raise max_tokens or lower effort for this role`,
      );
    }

    const text = message.content
      .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const usage = message.usage;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    return {
      text,
      // Summed so tokensIn is the whole prompt, as with other providers.
      tokensIn: usage.input_tokens + cacheRead + cacheWrite,
      tokensOut: usage.output_tokens,
      cachedTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      model: message.model || req.model,
    };
  }
}
