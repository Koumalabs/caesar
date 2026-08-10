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

/** Vrai si le schéma d'une propriété porte la clé `default` que `z.toJSONSchema` laisse pour tout champ `.default(...)` du zod d'origine — voir `walk` ci-dessous. */
function hasDefault(propertySchema: unknown): boolean {
  return typeof propertySchema === "object" && propertySchema !== null && "default" in propertySchema;
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
    // I2 de la revue finale : `Object.keys(properties)` rendait tout
    // obligatoire sans distinction, y compris des champs purement
    // optionnels sans défaut (`usage`, `findings[].file`,
    // `findings[].line`) — le modèle devait alors fabriquer une valeur (un
    // coût en dollars mesuré, une ligne inventée), et un `0` de repli pour
    // `line` échouait ensuite à la revalidation par `ReportSchema`
    // (`exclusiveMinimum: 0`, vérifié par la revue : `too_small: expected
    // number to be >0`).
    //
    // Restent obligatoires uniquement : les champs déjà mandatoires côté
    // zod — repris tels quels du `required` que `z.toJSONSchema` (mode
    // "input") a déjà calculé correctement pour ce noeud, avant qu'il ne
    // soit écrasé ci-dessous (`protocol`/`status`/`summary` au niveau
    // racine, `path`/`action` pour un `Change`…) — et les champs porteurs
    // d'une valeur par défaut (`hasDefault`) : répéter le défaut n'est
    // jamais une fabrication, contrairement à inventer un champ purement
    // optionnel qui n'en a pas.
    const alreadyRequired = new Set(Array.isArray(out["required"]) ? (out["required"] as unknown[]) : []);
    const props = properties as Record<string, unknown>;
    out["required"] = Object.keys(props).filter((key) => alreadyRequired.has(key) || hasDefault(props[key]));
  }
  return out;
}
