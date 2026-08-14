/**
 * `ConfigState` factory for the render tests (`*.render.test.tsx`) and the
 * pure tests of `config-state.test.ts` that do not need to touch the
 * disk: the three layers empty, the effective merge is then exactly
 * `defaultConfig()` (see `mergeConfig`, `@caesar/core` — merging with an
 * empty override is a no-op). Centralized here rather than copied into
 * each test file (which was the case until task 15, with the risk that a
 * fix made in one file would not be carried over to the others).
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
