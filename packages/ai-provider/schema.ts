import type { JsonSchema } from "./types";

/**
 * Schema normalisation for providers that actually validate.
 *
 * Gemini accepts a loose OpenAPI dialect: `nullable: true`, `format: "enum"`,
 * optional properties, no `additionalProperties`. Strict validators reject all
 * of that. This targets the tightest boundary published by the OpenAI-compatible
 * hosts we support, so one normalised schema satisfies all of them:
 *
 *   - supported: object, string, number, integer, boolean, array, enum, anyOf
 *   - every property must appear in `required`
 *   - every object must set `additionalProperties: false`
 *   - minLength/maxLength and minItems/maxItems are not supported
 *
 * "Every property must be required" sounds like it forbids optional fields, but
 * it does not: the strict dialect expresses optionality as a union with null,
 * which is why `nullable: true` becomes `anyOf: [T, {type: "null"}]` rather than
 * being dropped from `required`.
 */

/** Keywords strict mode rejects outright. Stripped rather than passed through. */
const UNSUPPORTED_KEYWORDS = ["minLength", "maxLength", "minItems", "maxItems", "pattern", "default"];

/**
 * Rewrites a schema into the strict dialect.
 *
 * Idempotent, and safe on schemas that are already strict.
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};

  if (schema.description) out.description = schema.description;

  // `format: "enum"` is Gemini's spelling; the bare `enum` array is the portable
  // half and the only part a strict validator understands.
  if (schema.enum) {
    out.type = schema.type ?? "string";
    out.enum = schema.enum;
    return maybeNullable(out, schema.nullable);
  }

  if (schema.anyOf) {
    out.anyOf = schema.anyOf.map(toStrictSchema);
    return out;
  }

  if (schema.type === "object" && schema.properties) {
    out.type = "object";
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toStrictSchema(value)]),
    );
    // Strict mode requires the full property list here. Fields that were
    // genuinely optional are expressed as nullable unions by maybeNullable().
    out.required = Object.keys(schema.properties);
    out.additionalProperties = false;
    return maybeNullable(out, schema.nullable);
  }

  if (schema.type === "array" && schema.items) {
    out.type = "array";
    out.items = toStrictSchema(schema.items);
    return maybeNullable(out, schema.nullable);
  }

  if (schema.type) out.type = schema.type;
  return maybeNullable(out, schema.nullable);
}

/**
 * Expresses OpenAPI `nullable: true` as a strict-dialect union.
 *
 * Kept separate so the recursion above reads as one rule per node type.
 */
function maybeNullable(schema: JsonSchema, nullable?: boolean): JsonSchema {
  if (!nullable) return schema;
  return { anyOf: [schema, { type: "null" }] };
}

/**
 * Renders a schema as prompt text.
 *
 * The fallback path for providers that only offer `{"type": "json_object"}` —
 * valid JSON is guaranteed, conformance to *our* JSON is not, so the shape has
 * to be described in-band. Some hosts additionally reject a JSON-mode request
 * unless the word "json" appears in the prompt, which this wording satisfies.
 */
export function describeSchema(schema: JsonSchema): string {
  const strict = toStrictSchema(schema);
  return [
    "Respond with a single json object and nothing else — no prose, no markdown fences.",
    "It must validate against this JSON Schema exactly:",
    JSON.stringify(strict, null, 2),
  ].join("\n");
}

/**
 * Strips keywords Gemini tolerates but strict validators reject.
 *
 * Applied on the way into providers rather than at the schema literals, so the
 * literals stay readable and one dialect does not leak into the other.
 */
export function stripUnsupported(schema: JsonSchema): JsonSchema {
  const clone = { ...schema } as Record<string, unknown>;
  for (const key of UNSUPPORTED_KEYWORDS) delete clone[key];
  return clone as JsonSchema;
}
