import type { JsonSchema } from "./types";

// Normalises the loose OpenAPI-style schema literals into the strictest common
// dialect: all properties required, objects closed, optionality as null unions.

const UNSUPPORTED_KEYWORDS = ["minLength", "maxLength", "minItems", "maxItems", "pattern", "default"];

/** Rewrites a schema into the strict dialect; idempotent. */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};

  if (schema.description) out.description = schema.description;

  // Only the bare `enum` array is portable; `format: "enum"` is dropped.
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

function maybeNullable(schema: JsonSchema, nullable?: boolean): JsonSchema {
  if (!nullable) return schema;
  return { anyOf: [schema, { type: "null" }] };
}

/** Schema as prompt text for json_object mode; some hosts require the word "json" in the prompt. */
export function describeSchema(schema: JsonSchema): string {
  const strict = toStrictSchema(schema);
  return [
    "Respond with a single json object and nothing else — no prose, no markdown fences.",
    "It must validate against this JSON Schema exactly:",
    JSON.stringify(strict, null, 2),
  ].join("\n");
}

/** Strips keywords some providers reject outright. */
export function stripUnsupported(schema: JsonSchema): JsonSchema {
  const clone = { ...schema } as Record<string, unknown>;
  for (const key of UNSUPPORTED_KEYWORDS) delete clone[key];
  return clone as JsonSchema;
}
