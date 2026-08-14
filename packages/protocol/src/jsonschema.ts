import { z } from "zod";
import { TaskSchema } from "./task.js";
import { ReportSchema } from "./report.js";
import { EventSchema } from "./event.js";

export type JsonSchema = Record<string, unknown>;

export type SchemaName = "task" | "report" | "event";

const schemas = {
  task: TaskSchema,
  report: ReportSchema,
  event: EventSchema,
} as const;

/**
 * Publishes the standard as JSON Schema.
 *
 * We generate in `input` mode: fields carrying a default value are optional
 * there, which matches what an agent is allowed to omit.
 */
export function jsonSchemaFor(name: SchemaName): JsonSchema {
  return z.toJSONSchema(schemas[name], {
    io: "input",
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as JsonSchema;
}

/**
 * Variant intended for native structured outputs (`codex --output-schema`,
 * `agy --json-schema`).
 *
 * These providers require every object to forbid additional properties and
 * to declare **all** of its properties as required — the constraint is
 * checked API-side, which otherwise rejects the entire request:
 *
 *     Invalid schema for response_format 'codex_output_schema':
 *     In context=('properties', 'commands_run', 'items'), 'required' is required
 *     to be supplied and to be an array including every key in properties.
 *     Missing 'exit_code'.
 *
 * An optional field is therefore not expressed by removing it from
 * `required`, but by allowing it to be `null`: the model has nothing to make
 * up, it answers `null`. `dropNulls` (see `taskdir.ts`) then collapses those
 * `null`s back to absent fields before validation, so that the standard
 * itself keeps its "optional = absent" shape.
 */
export function strictReportJsonSchema(): JsonSchema {
  return tightenObjects(jsonSchemaFor("report"));
}

function tightenObjects(node: unknown): JsonSchema {
  return walk(node) as JsonSchema;
}

/** True if a property's schema carries the `default` key that `z.toJSONSchema` leaves for any `.default(...)` field of the original zod — see `walk` below. */
function hasDefault(propertySchema: unknown): boolean {
  return typeof propertySchema === "object" && propertySchema !== null && "default" in propertySchema;
}

/** True if the schema already admits `null` — `exit_code` does, its zod being `.nullish()`. */
function allowsNull(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  const schema = node as Record<string, unknown>;
  const type = schema["type"];
  if (type === "null") return true;
  if (Array.isArray(type) && type.includes("null")) return true;
  const anyOf = schema["anyOf"];
  return Array.isArray(anyOf) && anyOf.some(allowsNull);
}

/**
 * Allows `null` in addition to the original shape.
 *
 * The explicit union suits every shape encountered here — a scalar type
 * (`file`), a constrained integer (`line`), a nested object (`usage`) —
 * whereas adding `"null"` to the `type` field would assume that field exists
 * and is a string.
 */
function nullable(node: unknown): unknown {
  return allowsNull(node) ? node : { anyOf: [node, { type: "null" }] };
}

function walk(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(walk);
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = walk(value);
  }

  const properties = out["properties"];
  if (properties && typeof properties === "object") {
    out["additionalProperties"] = false;
    // The provider requires `required` to cover the entirety of
    // `properties` (see the error quoted at the top of the file). What was
    // learned in practice: removing a field from `required` — the first
    // form of I2 — does not excuse the model from providing it, it gets the
    // entire request rejected before the model even answers.
    //
    // I2's intent still holds, from the other end: a purely optional field
    // (`usage`, `findings[].file`, `findings[].line`) becomes nullable. The
    // model answers `null` rather than inventing a measured cost or a line
    // number — and the fallback `0` for `line`, which then failed
    // revalidation by `ReportSchema` (`exclusiveMinimum: 0`, verified by
    // the review: `too_small: expected number to be >0`), no longer has any
    // reason to exist.
    //
    // `alreadyRequired`: the `required` that `z.toJSONSchema` ("input" mode)
    // computed for this node, read before being overwritten below —
    // `protocol`/`status`/`summary` at the root level, `path`/`action` for a
    // `Change`… Those fields, like the ones carrying a default value
    // (`hasDefault`), do not become nullable: repeating a default is never
    // a fabrication.
    const alreadyRequired = new Set(Array.isArray(out["required"]) ? (out["required"] as unknown[]) : []);
    const props = properties as Record<string, unknown>;
    for (const [key, value] of Object.entries(props)) {
      if (alreadyRequired.has(key) || hasDefault(value)) continue;
      props[key] = nullable(value);
    }
    out["required"] = Object.keys(props);
  }
  return out;
}
