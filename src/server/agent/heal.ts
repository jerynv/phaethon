/**
 * Tool-argument healing. Weaker and local models often send a JSON value as a
 * string: `"options": "[{…}]"`, `"multiSelect": "true"`, `"role": "\"check\""`.
 * Where a value doesn't fit its schema and is a string, parse it and keep the
 * parsed value only if that fits. Nothing else is changed; anything still
 * wrong is reported by validation with instructions to fix it.
 */

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  anyOf?: Schema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

function typeOk(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** Does `value` fit `schema`? (The subset of JSON Schema the tools use.) */
export function fits(value: unknown, schema: Schema): boolean {
  if (schema.anyOf) return schema.anyOf.some((s) => fits(value, s));
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) return false;
  }
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every((v) => fits(v, schema.items!))) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) return false;
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties[k];
      if (!sub) {
        if (schema.additionalProperties === false) return false;
        continue;
      }
      if (!fits(v, sub)) return false;
    }
  }
  return true;
}

function parse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function healValue(value: unknown, schema: Schema): unknown {
  if (fits(value, schema)) return value;
  if (typeof value === "string") {
    const parsed = parse(value);
    if (parsed.ok) {
      const healed = healValue(parsed.value, schema);
      if (fits(healed, schema)) return healed;
    }
    return value;
  }
  if (Array.isArray(value) && schema.items) return value.map((v) => healValue(v, schema.items!));
  if (value && typeof value === "object" && schema.properties) return healObject(value as Record<string, unknown>, schema);
  return value;
}

function healObject(obj: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const sub = schema.properties?.[k];
    out[k] = sub ? healValue(v, sub) : v;
  }
  return out;
}

/** Repairs a tool call's input against the tool's input schema. Returns the input unchanged when nothing applies. */
export function healInput(input: unknown, schema: Record<string, unknown>): unknown {
  const s = schema as Schema;
  if (typeof input === "string") {
    const parsed = parse(input);
    if (parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) input = parsed.value;
    else return input;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return healObject(input as Record<string, unknown>, s);
}

/** Lists what's wrong with an input, each with how to fix it. Empty when it fits. */
export function schemaProblems(input: unknown, schema: Record<string, unknown>): string[] {
  const s = schema as Schema;
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["input must be a JSON object"];
  const obj = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(obj)) if (!s.properties?.[k]) out.push(`unexpected field "${k}"; the fields are ${Object.keys(s.properties ?? {}).join(", ") || "none"}`);
  for (const r of s.required ?? []) if (!(r in obj)) out.push(`"${r}" is required`);
  for (const [k, sub] of Object.entries(s.properties ?? {})) {
    if (!(k in obj) || fits(obj[k], sub)) continue;
    out.push(`"${k}" ${describe(sub)}`);
  }
  return out;
}

function describe(s: Schema): string {
  if (s.enum) return `must be one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")} (a plain value, not a quoted string)`;
  if (s.anyOf) return `must be ${s.anyOf.map((x) => kind(x)).join(" or ")}`;
  if (s.type === "array" && s.items) {
    const bounds = s.minItems !== undefined || s.maxItems !== undefined ? ` with ${s.minItems ?? 0} to ${s.maxItems ?? "any number of"} items` : "";
    return `must be a JSON array${bounds} (not a string holding one) of ${kind(s.items)}`;
  }
  return `must be ${kind(s)}`;
}

function kind(s: Schema): string {
  if (s.type === "object" && s.properties) return `objects with ${Object.keys(s.properties).map((k) => `"${k}"`).join(", ")}`;
  switch (s.type) {
    case "string":
      return "a string";
    case "boolean":
      return "true or false (not a string)";
    case "integer":
      return `a whole number${s.minimum !== undefined ? ` from ${s.minimum}` : ""}${s.maximum !== undefined ? ` to ${s.maximum}` : ""}`;
    case "number":
      return "a number";
    case "array":
      return "an array";
    case "object":
      return "an object";
    default:
      return "a valid value";
  }
}
