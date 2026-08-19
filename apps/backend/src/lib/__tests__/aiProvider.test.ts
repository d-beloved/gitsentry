/**
 * Tests for the provider seam.
 *
 * These cover the failures that would otherwise be silent in production: a
 * schema that a strict validator rejects, cached tokens quietly counted as
 * zero (which understates cache hit rate and overstates cost), a routing block
 * sent to a host that 400s on it, and a structured mode that degrades without
 * saying so. None of these throw on their own — they just produce wrong numbers
 * or wrong output, which is why they are pinned here.
 */
import { toStrictSchema, describeSchema } from "../../../../../packages/ai-provider/schema";
import { OpenAICompatProvider } from "../../../../../packages/ai-provider/openaiCompat";
import type { JsonSchema } from "../../../../../packages/ai-provider/types";

/** A host serving its own model, and an aggregator routing between several. */
const HOST = "https://host.example/v1";
const AGGREGATOR = "https://aggregator.example/api/v1";

/** Captures the outgoing request so assertions can read the body it built. */
function mockFetch(payload: Record<string, unknown>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  global.fetch = jest.fn(async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("toStrictSchema", () => {
  it("converts nullable fields to a null union rather than dropping them", () => {
    // The strict dialect requires every property in `required`, so optionality
    // has to survive as anyOf — dropping it would silently forbid null.
    const out = toStrictSchema({
      type: "object",
      properties: { line_number: { type: "integer", nullable: true } },
    });
    expect(out.properties!.line_number).toEqual({
      anyOf: [{ type: "integer" }, { type: "null" }],
    });
    expect(out.required).toEqual(["line_number"]);
  });

  it("marks every object closed and lists all properties as required", () => {
    const out = toStrictSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
    });
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(["a", "b"]);
  });

  it("keeps enum values while dropping Gemini's format: enum spelling", () => {
    const out = toStrictSchema({ type: "string", format: "enum", enum: ["high", "low"] });
    expect(out.enum).toEqual(["high", "low"]);
    expect(out.format).toBeUndefined();
  });

  it("recurses through arrays of objects", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: { type: "object", properties: { file: { type: "string" } } },
        },
      },
    };
    const items = toStrictSchema(schema).properties!.issues.items!;
    expect(items.additionalProperties).toBe(false);
    expect(items.required).toEqual(["file"]);
  });

  it("is idempotent", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { n: { type: "integer", nullable: true } },
    };
    expect(toStrictSchema(toStrictSchema(schema))).toEqual(toStrictSchema(schema));
  });
});

describe("describeSchema", () => {
  // Some hosts reject a JSON-mode request outright unless the prompt says "json".
  it("contains the literal word json so JSON mode accepts the call", () => {
    expect(describeSchema({ type: "object", properties: {} })).toMatch(/json/);
  });
});

describe("OpenAICompatProvider — token accounting", () => {
  it("reads the flat prompt_cache_hit_tokens spelling", async () => {
    mockFetch({
      model: "some-model",
      choices: [{ message: { content: "{}" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800 },
    });
    const res = await new OpenAICompatProvider({ apiKey: "k", baseURL: HOST }).generate({
      model: "some-model",
      prompt: "hi",
    });
    expect(res).toMatchObject({ tokensIn: 1000, tokensOut: 50, cachedTokens: 800 });
  });

  it("reads the nested prompt_tokens_details.cached_tokens spelling", async () => {
    mockFetch({
      choices: [{ message: { content: "{}" } }],
      usage: {
        prompt_tokens: 900,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 700 },
      },
    });
    const res = await new OpenAICompatProvider({ apiKey: "k", baseURL: AGGREGATOR }).generate({
      model: "vendor/model",
      prompt: "hi",
    });
    expect(res.cachedTokens).toBe(700);
  });

  it("reports zero rather than NaN when a provider omits usage entirely", async () => {
    mockFetch({ choices: [{ message: { content: "{}" } }] });
    const res = await new OpenAICompatProvider({ apiKey: "k", baseURL: HOST }).generate({
      model: "m",
      prompt: "hi",
    });
    expect(res).toMatchObject({ tokensIn: 0, tokensOut: 0, cachedTokens: 0 });
  });
});

describe("OpenAICompatProvider — structured output", () => {
  const schema: JsonSchema = { type: "object", properties: { a: { type: "string" } } };

  it("defaults to json_object, the only mode every host implements", async () => {
    // Guessing high fails every scan on a host that does not enforce schemas;
    // guessing low costs a described-in-prompt schema. AI_STRUCTURED_MODE raises
    // it once the eval confirms the endpoint honours the stronger mode.
    const calls = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await new OpenAICompatProvider({ apiKey: "k", baseURL: HOST }).generate({
      model: "m",
      prompt: "hi",
      schema,
    });
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    expect(calls[0].body.tools).toBeUndefined();
  });

  it("sends strict json_schema when configured for it", async () => {
    const calls = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await new OpenAICompatProvider({
      apiKey: "k",
      baseURL: AGGREGATOR,
      structuredMode: "json_schema",
    }).generate({ model: "m", prompt: "hi", schema, schemaName: "analysis" });

    const rf = calls[0].body.response_format as { type: string; json_schema: { strict: boolean } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
  });

  it("forces the function call in tool_strict and reads the payload back off it", async () => {
    const calls = mockFetch({
      choices: [{ message: { tool_calls: [{ function: { arguments: '{"a":"x"}' } }] } }],
    });
    const res = await new OpenAICompatProvider({
      apiKey: "k",
      baseURL: HOST,
      structuredMode: "tool_strict",
    }).generate({ model: "m", prompt: "hi", schema, schemaName: "analysis" });

    // Without tool_choice the model may answer in prose and skip the schema.
    expect(calls[0].body.tool_choice).toEqual({
      type: "function",
      function: { name: "analysis" },
    });
    // The payload lives in function.arguments, not content.
    expect(res.text).toBe('{"a":"x"}');
  });

  it("posts to the configured base URL verbatim, whatever the mode", async () => {
    // Hosts that serve strict tool calling from a separate path are configured
    // that way in AI_BASE_URL — nothing here rewrites the operator's URL.
    const calls = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await new OpenAICompatProvider({
      apiKey: "k",
      baseURL: "https://host.example/v1/beta",
      structuredMode: "tool_strict",
    }).generate({ model: "m", prompt: "hi", schema });
    expect(calls[0].url).toBe("https://host.example/v1/beta/chat/completions");
  });

  it("puts the schema description in the cached prefix in json_object mode", async () => {
    // Appending it to the variable tail would push a large constant past the
    // cache breakpoint on every single call.
    const calls = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await new OpenAICompatProvider({ apiKey: "k", baseURL: HOST }).generate({
      model: "m",
      system: "RUBRIC",
      prompt: "diff",
      schema,
    });
    const messages = calls[0].body.messages as { role: string; content: unknown }[];
    const systemText = (messages[0].content as { text: string }[])[0].text;
    expect(systemText).toContain("RUBRIC");
    expect(systemText).toMatch(/JSON Schema/);
    expect(messages[1].content).toBe("diff");
  });
});

describe("OpenAICompatProvider — routing and caching", () => {
  it("marks the system prefix as a cache breakpoint", async () => {
    const calls = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await new OpenAICompatProvider({ apiKey: "k", baseURL: HOST }).generate({
      model: "m",
      system: "stable rubric",
      prompt: "variable diff",
    });
    const messages = calls[0].body.messages as { content: { cache_control?: unknown }[] }[];
    expect(messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits the routing block when no pin is configured — hosts 400 on unknown keys", async () => {
    const calls = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await new OpenAICompatProvider({ apiKey: "k", baseURL: HOST }).generate({
      model: "m",
      prompt: "hi",
    });
    expect(calls[0].body.provider).toBeUndefined();
  });

  it("pins routing when asked and refuses retention-happy endpoints", async () => {
    const calls = mockFetch({ choices: [{ message: { content: "{}" } }] });
    await new OpenAICompatProvider({
      apiKey: "k",
      baseURL: AGGREGATOR,
      providerOrder: ["primary", "secondary"],
      allowFallbacks: false,
    }).generate({ model: "m", prompt: "hi" });

    expect(calls[0].body.provider).toEqual({
      order: ["primary", "secondary"],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
    });
  });

  it("surfaces the response body on a non-2xx so failures are diagnosable", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    })) as unknown as typeof fetch;

    await expect(
      new OpenAICompatProvider({ apiKey: "k", baseURL: HOST }).generate({
        model: "m",
        prompt: "hi",
      }),
    ).rejects.toThrow(/429.*rate limited/);
  });
});
