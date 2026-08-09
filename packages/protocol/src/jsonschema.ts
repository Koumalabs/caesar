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
 * Publie le standard sous forme de JSON Schema.
 *
 * On génère en mode `input` : les champs pourvus d'une valeur par défaut y sont
 * facultatifs, ce qui correspond à ce qu'un agent a le droit d'omettre.
 */
export function jsonSchemaFor(name: SchemaName): JsonSchema {
  return z.toJSONSchema(schemas[name], {
    io: "input",
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as JsonSchema;
}

/**
 * Variante destinée aux sorties structurées natives (`codex --output-schema`,
 * `agy --json-schema`).
 *
 * Ces fournisseurs imposent que chaque objet interdise les propriétés
 * supplémentaires et déclare toutes ses propriétés comme requises. On rend donc
 * l'ensemble obligatoire : le modèle devra fournir les tableaux vides plutôt que
 * de les omettre, ce qui reste conforme au standard.
 */
export function strictReportJsonSchema(): JsonSchema {
  return tightenObjects(jsonSchemaFor("report"));
}

function tightenObjects(node: unknown): JsonSchema {
  return walk(node) as JsonSchema;
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
    out["required"] = Object.keys(properties as Record<string, unknown>);
  }
  return out;
}
