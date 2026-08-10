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
 * supplémentaires et déclare **toutes** ses propriétés comme requises — la
 * contrainte est vérifiée côté API, qui refuse la requête entière sinon :
 *
 *     Invalid schema for response_format 'codex_output_schema':
 *     In context=('properties', 'commands_run', 'items'), 'required' is required
 *     to be supplied and to be an array including every key in properties.
 *     Missing 'exit_code'.
 *
 * Un champ facultatif ne s'exprime donc pas en le retirant de `required`, mais
 * en l'autorisant à valoir `null` : le modèle n'a rien à fabriquer, il répond
 * `null`. `dropNulls` (voir `taskdir.ts`) ramène ensuite ces `null` à des champs
 * absents avant validation, de sorte que le standard, lui, garde sa forme
 * « facultatif = absent ».
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

/** Vrai si le schéma admet déjà `null` — `exit_code` l'admet, son zod étant `.nullish()`. */
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
 * Autorise `null` en plus de la forme d'origine.
 *
 * L'union explicite convient à toutes les formes rencontrées ici — un type
 * scalaire (`file`), un entier contraint (`line`), un objet imbriqué (`usage`) —
 * là où l'ajout de `"null"` au champ `type` supposerait que ce champ existe et
 * soit une chaîne.
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
    // Le fournisseur exige que `required` couvre l'intégralité de
    // `properties` (voir l'erreur citée en tête de fichier). Ce qui a été
    // appris à l'usage : retirer un champ de `required` — la première forme
    // d'I2 — ne dispense pas le modèle de le fournir, elle fait refuser la
    // requête entière avant même qu'il ne réponde.
    //
    // L'intention d'I2 reste tenue, par l'autre bout : un champ purement
    // facultatif (`usage`, `findings[].file`, `findings[].line`) devient
    // nullable. Le modèle répond `null` plutôt que d'inventer un coût mesuré
    // ou un numéro de ligne — et le `0` de repli pour `line`, qui échouait
    // ensuite à la revalidation par `ReportSchema` (`exclusiveMinimum: 0`,
    // vérifié par la revue : `too_small: expected number to be >0`), n'a plus
    // lieu d'être.
    //
    // `alreadyRequired` : le `required` que `z.toJSONSchema` (mode "input") a
    // calculé pour ce noeud, lu avant d'être écrasé ci-dessous —
    // `protocol`/`status`/`summary` au niveau racine, `path`/`action` pour un
    // `Change`… Ces champs-là, comme ceux porteurs d'une valeur par défaut
    // (`hasDefault`), ne deviennent pas nullables : répéter un défaut n'est
    // jamais une fabrication.
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
