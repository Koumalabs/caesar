/**
 * Valeurs valides des flags `--mode`/`--isolation`, dérivées des schémas
 * d'`@orch/protocol` plutôt que recopiées littéralement : un ajout de
 * variante au protocole (`TaskModeSchema`/`IsolationSchema`) se répercute
 * ici sans correction manuelle, ce qu'une paire de tableaux recopiés à la
 * main ne garantissait pas (tâche 10, B2 — `role.ts` et `run.ts`
 * définissaient jusqu'ici cette même paire, à l'identique, chacun de son
 * côté).
 *
 * `"auto"` n'existe pas côté protocole : c'est un sentinel propre à la
 * politique de délégation (`@orch/core`, `config.ts`, `default_isolation`),
 * ajouté ici explicitement plutôt que dérivé.
 *
 * Cette validation de *forme* (une chaîne brute issue de `commander`) reste
 * délibérément propre au CLI, jamais dans `@orch/core` : voir l'en-tête de
 * `resolveDelegation` (`packages/core/src/delegation.ts`), dont les entrées
 * sont déjà typées quand elle est appelée.
 */
import { IsolationSchema, TaskModeSchema } from "@orch/protocol";
import type { Isolation, TaskMode } from "@orch/protocol";
import { NETWORK_REQUESTS } from "@orch/core";
import type { NetworkRequest } from "@orch/core";

export const TASK_MODES: readonly TaskMode[] = TaskModeSchema.options;
export const ISOLATIONS: readonly (Isolation | "auto")[] = [...IsolationSchema.options, "auto"];

/**
 * `--network`. Comme `"auto"` pour l'isolation, ces trois valeurs n'existent
 * pas côté protocole : la `Task` ne porte qu'un booléen résolu. Elles vivent
 * dans `@orch/core` (`network.ts`), d'où elles sont dérivées ici.
 */
export const NETWORK_REQUEST_VALUES: readonly NetworkRequest[] = NETWORK_REQUESTS;
