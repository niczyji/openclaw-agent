// tools/schema.ts
import type { JsonSchema } from "../core/types.js";

/**
 * Tiny helpers to build a JSON-Schema subset (the one used in core/types.ts).
 * Keeps schemas consistent and readable.
 */

export function sString(opts?: { enum?: readonly string[] }): JsonSchema {
  return opts?.enum ? { type: "string", enum: opts.enum } : { type: "string" };
}

export function sBoolean(): JsonSchema {
  return { type: "boolean" };
}

export function sNumber(): JsonSchema {
  return { type: "number" };
}

export function sInteger(): JsonSchema {
  return { type: "integer" };
}

export function sNull(): JsonSchema {
  return { type: "null" };
}

export function sArray(items: JsonSchema): JsonSchema {
  return { type: "array", items };
}

export function sObject(params: {
  properties: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
}): JsonSchema {
  return {
    type: "object",
    properties: params.properties,
    required: params.required,
    additionalProperties: params.additionalProperties ?? false,
  };
}
