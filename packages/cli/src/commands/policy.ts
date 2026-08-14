/**
 * `caesar policy show|allow|deny`.
 *
 * `policy show` indicates, for each value, which layer it comes from
 * (global, project, local, or default) — directly from `layers`
 * (`@caesar/core`, `loadConfig`): each layer exposes exactly what it
 * declares, so provenance is the last layer declaring a field, without
 * having to reload the configuration several times to guess it by
 * difference (see `policyFieldProvenance`, which replaced this module's old
 * `computeProvenance` — three `loadConfig` loads, with `HOME` or the
 * project root momentarily neutralized).
 *
 * `policy allow|deny` write a single layer (`--global`/`--local`, project
 * by default) — never the merge: see `materializePolicyList`
 * (`@caesar/core`), which carries all the list materialization logic. This
 * facade only picks the layer and formats the result.
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
  // Provenance in half-tone: it is the column one only reads when a value
  // is surprising, never the one one comes for.
  const rows: Cell[][] = keys.map((key) => [
    key,
    JSON.stringify(config.policy[key]),
    { text: provenance[key], token: "dim" },
  ]);
  printTable(io, ["field", "value", "provenance"], rows);
  return EXIT_OK;
}

export interface PolicyEditOptions extends ScopeOptions {
  json?: boolean;
}

interface PolicyListUpdate {
  scope: ConfigScope;
  effective: string[];
  materialized: boolean;
  /** True if the "allowed" list went from empty to non-empty — see CONTROLLER-2 of the final review. */
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
    printDone(io, `Agent "${id}" added to the "allowed" list (${scopeLabel(scope)} layer).`);
    // CONTROLLER-2 of the final review: "allow" started from an empty
    // list — where any non-denied agent passed — and now makes it
    // restrictive. A user who wanted to "allow one more agent" just banned
    // all the others without knowing; this message is the only signal
    // before a future "caesar doctor".
    if (wasEmptyAllowlist) {
      writeLine(
        io.stdout,
        `${colorize(activeGlyphs().status.warn, "warn", io.stdout)} ` +
          colorize("Warning", "warn", io.stdout) +
          `: the "allowed" list was empty (all non-denied agents passed); it now contains ` +
          `only "${id}" — the other agents are now denied. To allow one more agent without ` +
          `restricting the others, prefer "caesar policy deny"/"caesar agents disable" on what you want to exclude.`,
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
    printDone(io, `Agent "${id}" added to the "denied" list (${scopeLabel(scope)} layer).`);
    if (materialized) printNote(io, materializationNotice("denied", scope, effective));
  }
  return EXIT_OK;
}
