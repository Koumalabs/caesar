/**
 * Small display utilities shared by `PolicyScreen` and `RolesScreen` — the
 * only two screens that cycle a value through a fixed set (mode,
 * isolation) or that format/walk the same agent catalog. Copied verbatim
 * between the two until now (task 10, B), with the risk that a fix made
 * in one would not be carried over to the other.
 */
import type { GenericAgentSpec } from "@caesar/core";
import { listAgentDefinitions, NETWORK_REQUESTS } from "@caesar/core";
import { IsolationSchema, TaskModeSchema } from "@caesar/protocol";

export const MODE_OPTIONS = TaskModeSchema.options;
export const ISOLATION_OPTIONS = [...IsolationSchema.options, "auto"] as const;
export const NETWORK_OPTIONS = NETWORK_REQUESTS;

/**
 * Catalog identifiers, native ones extended with the configuration's
 * agents (`state.draft.agents`, `[[agent]]` in the TOML) — see C1 of the
 * final review. `CATALOG_IDS` was until now a constant frozen at module
 * load (`listAgentDefinitions()` with no argument), which could therefore
 * never reflect an agent declared in configuration: neither the
 * Roles/Policy screens (fallback order, allowed/denied lists) could offer
 * it with "a", nor — until `AgentsScreen` was fixed with the same gesture
 * — could the Agents screen list it. A function rather than a constant:
 * called with the current configuration on every render.
 */
export function catalogIds(extraAgents: readonly GenericAgentSpec[] = []): string[] {
  return listAgentDefinitions(extraAgents).map((def) => def.id);
}

/** Formats `ms` in the widest unit that divides it exactly (h, m, s), otherwise in raw milliseconds. */
export function formatMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** Next value in `options`, looping past the last one. */
export function cycle<T>(options: readonly T[], current: T): T {
  const index = options.indexOf(current);
  return options[(index + 1) % options.length]!;
}

// `fitColumn` lived here: it padded a cell to a width hard-coded in each
// screen. Replaced by `cell` (`ui/layout.ts`), which no longer decides the
// width on its own — that comes from `layoutColumns`, hence from the room
// actually available, gutter included.
