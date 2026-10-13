// Pins the request the Anthropic adapter builds and the responses it must not treat as clean.
const streamCalls: { params: Record<string, unknown>; options: Record<string, unknown> }[] = [];
let nextMessage: Record<string, unknown>;

jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: class {
    beta = {
      messages: {
        stream: (params: Record<string, unknown>, options: Record<string, unknown>) => {
          streamCalls.push({ params, options });
          return { finalMessage: async () => nextMessage };
        },
      },
    };
  },
}));

import { AnthropicProvider } from "../../../../../packages/ai-provider/anthropic";

function message(overrides: Record<string, unknown> = {}) {
  return {
    model: "model-a",
    stop_reason: "end_turn",
    stop_details: null,
    content: [
      { type: "thinking", thinking: "…" },
      { type: "text", text: '{"issues":[]}' },
    ],
    usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 50 },
    ...overrides,
  };
}

beforeEach(() => {
  streamCalls.length = 0;
  nextMessage = message();
});

describe("AnthropicProvider — request", () => {
  it("marks the system prefix as a cache breakpoint", async () => {
    await new AnthropicProvider({ apiKey: "k" }).generate({ model: "m", system: "RUBRIC", prompt: "DIFF" });
    const { params } = streamCalls[0];
    expect(params.system).toEqual([{ type: "text", text: "RUBRIC", cache_control: { type: "ephemeral" } }]);
    expect(params.messages).toEqual([{ role: "user", content: "DIFF" }]);
  });

  it("keeps the effort knob alongside the response schema", async () => {
    await new AnthropicProvider({ apiKey: "k" }).generate({
      model: "m",
      prompt: "p",
      schema: { type: "object", properties: { n: { type: "integer", nullable: true } } },
      extraBody: { output_config: { effort: "high" } },
    });
    const config = streamCalls[0].params.output_config as Record<string, unknown>;
    expect(config.effort).toBe("high");
    expect(config.format).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        properties: { n: { anyOf: [{ type: "integer" }, { type: "null" }] } },
        required: ["n"],
        additionalProperties: false,
      },
    });
  });

  it("opts into server-side fallback on a policy decline", async () => {
    await new AnthropicProvider({ apiKey: "k" }).generate({ model: "m", prompt: "p" });
    expect(streamCalls[0].params).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
  });
});

describe("AnthropicProvider — response", () => {
  it("returns only text blocks and counts cached tokens inside tokensIn", async () => {
    const res = await new AnthropicProvider({ apiKey: "k" }).generate({ model: "m", prompt: "p" });
    expect(res).toMatchObject({
      text: '{"issues":[]}',
      tokensIn: 4100,
      cachedTokens: 4000,
      cacheWriteTokens: 0,
      tokensOut: 50,
      model: "model-a",
    });
  });

  it("throws on a refusal rather than returning an empty answer", async () => {
    nextMessage = message({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
      content: [],
    });
    await expect(new AnthropicProvider({ apiKey: "k" }).generate({ model: "m", prompt: "p" })).rejects.toThrow(
      /declined the request \(cyber\)/,
    );
  });

  it("throws when the answer was cut off by max_tokens", async () => {
    nextMessage = message({ stop_reason: "max_tokens" });
    await expect(new AnthropicProvider({ apiKey: "k" }).generate({ model: "m", prompt: "p" })).rejects.toThrow(
      /max_tokens/,
    );
  });
});
