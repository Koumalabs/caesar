/**
 * Petits utilitaires d'affichage partagés par `PolicyScreen` et
 * `RolesScreen` — les deux seuls écrans qui cyclent une valeur parmi un
 * ensemble fixe (mode, isolation) ou qui formatent/parcourent le même
 * catalogue d'agents. Recopiés à l'identique entre les deux jusqu'ici
 * (tâche 10, B), avec le risque qu'une correction faite dans l'un ne soit
 * pas reportée dans l'autre.
 */
import { listAgentDefinitions } from "@orch/core";
import { IsolationSchema, TaskModeSchema } from "@orch/protocol";

export const MODE_OPTIONS = TaskModeSchema.options;
export const ISOLATION_OPTIONS = [...IsolationSchema.options, "auto"] as const;
export const CATALOG_IDS = listAgentDefinitions().map((def) => def.id);

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
