import { z } from "zod";

/**
 * Convert a tool's JSON-Schema `input_schema` into a Zod "raw shape"
 * ({ field: ZodType }) — the form the Agent SDK's `tool()` helper requires.
 *
 * Covers the subset of JSON Schema the Dash tools actually use: string /
 * number / integer / boolean / array / object, plus `enum`, `default`,
 * `description`, and `required` (→ `.optional()`). Anything unrecognized
 * degrades to `z.any()` rather than throwing, so a new tool never breaks
 * startup — it just gets a permissive schema.
 */
export function toZodShape(inputSchema) {
  const props = inputSchema?.properties;
  if (!props || typeof props !== "object") return {};

  const required = new Set(inputSchema.required || []);
  const shape = {};

  for (const [name, prop] of Object.entries(props)) {
    let field = convert(prop);

    if (prop && typeof prop.description === "string") {
      field = field.describe(prop.description);
    }
    if (prop && Object.prototype.hasOwnProperty.call(prop, "default")) {
      field = field.default(prop.default); // implies optional
    } else if (!required.has(name)) {
      field = field.optional();
    }

    shape[name] = field;
  }

  return shape;
}

/** Convert a single JSON-Schema node to a base ZodType. */
function convert(prop) {
  if (!prop || typeof prop !== "object") return z.any();

  // enum of string literals -> z.enum
  if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.every((v) => typeof v === "string")) {
    return z.enum(prop.enum);
  }

  switch (prop.type) {
    case "string":
      return z.string();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(prop.items ? convert(prop.items) : z.any());
    case "object":
      return prop.properties ? z.object(toZodShape(prop)) : z.record(z.any());
    default:
      return z.any();
  }
}
