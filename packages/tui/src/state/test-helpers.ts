/**
 * Fabrique de `ConfigState` pour les tests de rendu (`*.render.test.tsx`) et
 * les tests purs de `config-state.test.ts` qui n'ont pas besoin de toucher le
 * disque : les trois couches vides, la fusion effective vaut alors
 * exactement `defaultConfig()` (voir `mergeConfig`, `@caesar/core` — fusionner
 * avec un override vide est un no-op). Centralisé ici plutôt que recopié
 * dans chaque fichier de test (c'était le cas jusqu'à la tâche 15, avec le
 * risque qu'une correction faite dans un fichier ne soit pas reportée dans
 * les autres).
 */
import type { ConfigLayer, ConfigScope } from "@caesar/core";
import type { ConfigState } from "./config-state";

export function emptyConfigState(activeScope: ConfigScope = "project"): ConfigState {
  const layers: ConfigLayer[] = [
    { scope: "global", path: "/fake/global.toml", override: {} },
    { scope: "project", path: "/fake/project.toml", override: {} },
    { scope: "local", path: "/fake/local.toml", override: {} },
  ];
  return { layers, activeScope, draft: {} };
}
