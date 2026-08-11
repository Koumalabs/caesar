/**
 * Petits utilitaires d'affichage partagés par `PolicyScreen` et
 * `RolesScreen` — les deux seuls écrans qui cyclent une valeur parmi un
 * ensemble fixe (mode, isolation) ou qui formatent/parcourent le même
 * catalogue d'agents. Recopiés à l'identique entre les deux jusqu'ici
 * (tâche 10, B), avec le risque qu'une correction faite dans l'un ne soit
 * pas reportée dans l'autre.
 */
import type { GenericAgentSpec } from "@orch/core";
import { listAgentDefinitions } from "@orch/core";
import { IsolationSchema, TaskModeSchema } from "@orch/protocol";

export const MODE_OPTIONS = TaskModeSchema.options;
export const ISOLATION_OPTIONS = [...IsolationSchema.options, "auto"] as const;

/**
 * Identifiants du catalogue, natif étendu des agents de configuration
 * (`state.draft.agents`, `[[agent]]` du TOML) — voir C1 de la revue finale.
 * `CATALOG_IDS` était jusqu'ici une constante figée au chargement du module
 * (`listAgentDefinitions()` sans argument), qui ne pouvait donc jamais
 * refléter un agent déclaré en configuration : ni les écrans Rôles/Politique
 * (ordre de repli, listes allowed/denied) ne pouvaient le proposer avec "a",
 * ni — jusqu'à ce que `AgentsScreen` soit corrigé au même geste — l'écran
 * Agents ne pouvait le lister. Fonction plutôt que constante : appelée avec
 * la configuration courante à chaque rendu.
 */
export function catalogIds(extraAgents: readonly GenericAgentSpec[] = []): string[] {
  return listAgentDefinitions(extraAgents).map((def) => def.id);
}

/** Formate `ms` dans l'unité la plus large qui le divise exactement (h, m, s), sinon en millisecondes brutes. */
export function formatMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** Valeur suivante dans `options`, en boucle après la dernière. */
export function cycle<T>(options: readonly T[], current: T): T {
  const index = options.indexOf(current);
  return options[(index + 1) % options.length]!;
}

// `fitColumn` vivait ici : elle complétait une cellule à une largeur écrite
// en dur dans chaque écran. Remplacée par `cell` (`ui/layout.ts`), qui ne
// décide plus seule de la largeur — celle-ci vient de `layoutColumns`, donc
// de la place réellement disponible, gouttière comprise.
