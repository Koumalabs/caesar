/**
 * `caesar policy show|allow|deny`.
 *
 * `policy show` indique, pour chaque valeur, de quelle couche elle vient
 * (global, projet, local, ou défaut) — directement à partir de `layers`
 * (`@caesar/core`, `loadConfig`) : chaque couche expose exactement ce qu'elle
 * déclare, la provenance est donc la dernière couche qui déclare un champ,
 * sans avoir à recharger la configuration plusieurs fois pour le deviner par
 * différence (voir `policyFieldProvenance`, qui a remplacé l'ancien
 * `computeProvenance` de ce module — trois chargements de `loadConfig`, avec
 * `HOME` ou la racine du projet momentanément neutralisés).
 *
 * `policy allow|deny` écrivent une seule couche (`--global`/`--local`,
 * projet par défaut) — jamais la fusion : voir `materializePolicyList`
 * (`@caesar/core`), qui porte toute la logique de matérialisation de liste.
 * Cette façade ne fait que choisir la couche et mettre le résultat en forme.
 */
import type { ConfigScope, PolicyConfig } from "@caesar/core";
import { loadConfig, materializePolicyList, policyFieldProvenance } from "@caesar/core";
import type { Cell, Io } from "../output.js";
import {
  EXIT_OK,
  EXIT_USAGE,
  activeGlyphs,
  colorize,
  printDone,
  printError,
  printJson,
  printNote,
  printTable,
  sectionHeader,
  writeLine,
} from "../output.js";
import type { ScopeOptions } from "../scope.js";
import { materializationNotice, resolveScope, scopeLabel } from "../scope.js";

export interface PolicyShowOptions {
  json?: boolean;
}

export async function runPolicyShow(root: string, options: PolicyShowOptions, io: Io): Promise<number> {
  const { config, sources, layers } = await loadConfig(root);

  const keys = Object.keys(config.policy) as (keyof PolicyConfig)[];
  const provenance = Object.fromEntries(keys.map((key) => [key, policyFieldProvenance(layers, key)])) as Record<
    keyof PolicyConfig,
    ReturnType<typeof policyFieldProvenance>
  >;

  if (options.json) {
    printJson(io, { policy: config.policy, provenance, sources });
    return EXIT_OK;
  }

  sectionHeader(io, "policy");
  // La provenance en demi-ton : c'est la colonne qu'on ne lit que lorsqu'une
  // valeur surprend, jamais celle qu'on vient chercher.
  const rows: Cell[][] = keys.map((key) => [
    key,
    JSON.stringify(config.policy[key]),
    { text: provenance[key], token: "dim" },
  ]);
  printTable(io, ["champ", "valeur", "provenance"], rows);
  return EXIT_OK;
}

export interface PolicyEditOptions extends ScopeOptions {
  json?: boolean;
}

interface PolicyListUpdate {
  scope: ConfigScope;
  effective: string[];
  materialized: boolean;
  /** Vrai si la liste "allowed" passait de vide à non vide — voir CONTRÔLEUR-2 de la revue finale. */
  wasEmptyAllowlist: boolean;
}

async function setPolicyList(
  root: string,
  id: string,
  field: "allowed" | "denied",
  present: boolean,
  options: PolicyEditOptions,
): Promise<PolicyListUpdate | { error: string }> {
  const scope = resolveScope(options);
  if (typeof scope !== "string") return scope;

  const { config: before } = await loadConfig(root);
  const wasEmptyAllowlist = field === "allowed" && present && before.policy.allowed.length === 0;

  const { effective, materialized } = await materializePolicyList(root, scope, field, id, present);
  return { scope, effective, materialized, wasEmptyAllowlist };
}

export async function runPolicyAllow(root: string, id: string, options: PolicyEditOptions, io: Io): Promise<number> {
  const result = await setPolicyList(root, id, "allowed", true, options);
  if ("error" in result) {
    printError(io, result.error);
    return EXIT_USAGE;
  }
  const { scope, effective, materialized, wasEmptyAllowlist } = result;

  if (options.json) {
    printJson(io, { id, scope, allowed: effective, narrowed_allowlist: wasEmptyAllowlist, materialized });
  } else {
    printDone(io, `Agent "${id}" ajouté à la liste "allowed" (couche ${scopeLabel(scope)}).`);
    // CONTRÔLEUR-2 de la revue finale : "allow" partait d'une liste vide —
    // où tout agent non refusé passait — et la rend désormais restrictive.
    // Un utilisateur qui voulait "autoriser un agent de plus" vient d'en
    // interdire tous les autres sans le savoir ; ce message est le seul
    // signal avant un futur "caesar doctor".
    if (wasEmptyAllowlist) {
      writeLine(
        io.stdout,
        `${colorize(activeGlyphs().status.warn, "warn", io.stdout)} ` +
          colorize("Attention", "warn", io.stdout) +
          ` : la liste "allowed" était vide (tous les agents non refusés passaient) ; elle ne contient ` +
          `désormais que "${id}" — les autres agents sont maintenant refusés. Pour autoriser un agent de plus sans ` +
          `restreindre les autres, préférez "caesar policy deny"/"caesar agents disable" sur ce que vous voulez exclure.`,
      );
    }
    if (materialized) printNote(io, materializationNotice("allowed", scope, effective));
  }
  return EXIT_OK;
}

export async function runPolicyDeny(root: string, id: string, options: PolicyEditOptions, io: Io): Promise<number> {
  const result = await setPolicyList(root, id, "denied", true, options);
  if ("error" in result) {
    printError(io, result.error);
    return EXIT_USAGE;
  }
  const { scope, effective, materialized } = result;

  if (options.json) {
    printJson(io, { id, scope, denied: effective, materialized });
  } else {
    printDone(io, `Agent "${id}" ajouté à la liste "denied" (couche ${scopeLabel(scope)}).`);
    if (materialized) printNote(io, materializationNotice("denied", scope, effective));
  }
  return EXIT_OK;
}
