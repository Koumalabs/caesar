/**
 * `caesar role list|show|add|remove`.
 *
 * `add`/`remove` write a single layer (`--global`/`--local`, project by
 * default), never the merge: see the task 13 brief. Unlike the
 * `allowed`/`denied` lists (`policy.ts`, `materializePolicyList`), a role
 * is a keyed entry (`name`) that merges by whole replacement — no
 * "materialization" to do here, `add` directly replaces the targeted
 * layer's entry. `remove`, however, can only remove an entry the targeted
 * layer declares itself: a role inherited from a less specific layer (or
 * from the default) cannot be changed by "removing" it from a layer that
 * does not carry it — keyed merging cannot express a deletion, only a
 * replacement (see `mergeConfig`) —, say so clearly rather than returning
 * EXIT_OK without having changed anything.
 */
import type { NetworkRequest, RoleConfig } from "@caesar/core";
import { loadConfig, loadLayer, parseDuration, pickAgentForRole, resolveInstalledMap, resolveRole, roleProvenance, saveLayer } from "@caesar/core";
import type { Isolation, TaskMode } from "@caesar/protocol";
import { ISOLATIONS, NETWORK_REQUEST_VALUES, TASK_MODES } from "../flags.js";
import type { Cell, Io } from "../output.js";
import {
  EXIT_OK,
  EXIT_USAGE,
  printDone,
  printError,
  printField,
  printJson,
  printNote,
  printTable,
  sectionHeader,
  writeLine,
} from "../output.js";
import type { ScopeOptions } from "../scope.js";
import { resolveScope, scopeFlagHint, scopeLabel } from "../scope.js";

/** Agents referenced by a set of roles, all at once (`resolveInstalledMap` from `@caesar/core` only takes a single list). */
function agentIdsOf(roles: readonly RoleConfig[]): string[] {
  const ids = new Set<string>();
  for (const role of roles) for (const id of role.agents) ids.add(id);
  return [...ids];
}

export interface RoleListOptions {
  json?: boolean;
}

export async function runRoleList(root: string, options: RoleListOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);
  const installed = await resolveInstalledMap(agentIdsOf(config.roles), config.agents);

  const rows = config.roles.map((role) => {
    const pick = pickAgentForRole(role, { isInstalled: (id) => installed.get(id) ?? false, policy: config.policy });
    return {
      name: role.name,
      purpose: role.purpose,
      agents: role.agents,
      picked: "agentId" in pick ? pick.agentId : undefined,
      error: "error" in pick ? pick.error : undefined,
    };
  });

  if (options.json) {
    printJson(io, { roles: rows });
    return EXIT_OK;
  }

  sectionHeader(io, "role");
  const tableRows: Cell[][] = rows.map((r) => [
    r.name,
    { text: r.agents.join(" > "), token: "dim" },
    r.picked ? { text: r.picked, token: "ok" } : { text: `none (${r.error})`, token: "bad" },
  ]);
  printTable(io, ["role", "agents (fallback order)", "picked today"], tableRows);
  return EXIT_OK;
}

export interface RoleShowOptions {
  json?: boolean;
}

export async function runRoleShow(root: string, name: string, options: RoleShowOptions, io: Io): Promise<number> {
  const { config, layers } = await loadConfig(root);
  const resolved = await resolveRole(config, root, name);
  if (!resolved) {
    printError(io, `Unknown role: "${name}".`);
    return EXIT_USAGE;
  }
  const provenance = roleProvenance(layers, name);

  if (options.json) {
    printJson(io, { ...resolved, provenance });
    return EXIT_OK;
  }

  sectionHeader(io, `role ${resolved.name}`);
  // Aligned labels in half-tone, neutral values: the left column gets
  // skipped, the right one gets read.
  const LABEL_WIDTH = 22;
  printField(io, "provenance", provenance, LABEL_WIDTH);
  printField(io, "purpose", resolved.purpose || "(not specified)", LABEL_WIDTH);
  printField(io, "agents (fallback order)", resolved.agents.join(" > ") || "(none)", LABEL_WIDTH);
  printField(io, "mode", resolved.mode, LABEL_WIDTH);
  printField(io, "isolation", resolved.isolation, LABEL_WIDTH);
  printField(io, "network", resolved.network, LABEL_WIDTH);
  printField(io, "timeout", `${resolved.timeout_ms} ms`, LABEL_WIDTH);
  writeLine(io.stdout);
  printNote(io, "system prompt");
  writeLine(io.stdout, resolved.systemPrompt || "(none)");
  return EXIT_OK;
}

export interface RoleRemoveOptions extends ScopeOptions {
  json?: boolean;
}

export async function runRoleRemove(root: string, name: string, options: RoleRemoveOptions, io: Io): Promise<number> {
  const scope = resolveScope(options);
  if (typeof scope !== "string") {
    printError(io, scope.error);
    return EXIT_USAGE;
  }

  const { config, layers } = await loadConfig(root);
  if (!config.roles.some((role) => role.name === name)) {
    printError(io, `Unknown role: "${name}".`);
    return EXIT_USAGE;
  }

  const layer = await loadLayer(scope, root);
  if (!layer.roles?.some((role) => role.name === name)) {
    // Keyed merging (`mergeConfig`) replaces, it never deletes by absence: removing a role from a layer that does
    // not declare it would not make it disappear from the merge (it would remain carried by the layer that
    // actually declares it, or by `defaultConfig()`) — an EXIT_OK here would lie about what just happened.
    const actual = roleProvenance(layers, name);
    const hint =
      actual === "default"
        ? `it is part of the default configuration: no layer removes it, redefine it if you want to change its behavior.`
        : `it comes from the ${scopeLabel(actual)} layer: retry with ${scopeFlagHint(actual)}.`;
    printError(io, `Role "${name}" is not declared by the ${scopeLabel(scope)} layer: nothing to remove here, ${hint}`);
    return EXIT_USAGE;
  }

  const roles = layer.roles.filter((role) => role.name !== name);
  await saveLayer(scope, root, { ...layer, roles });

  if (options.json) printJson(io, { name, removed: true, scope });
  else printDone(io, `Role "${name}" removed (${scopeLabel(scope)} layer).`);
  return EXIT_OK;
}

export interface RoleAddOptions extends ScopeOptions {
  purpose?: string;
  agents?: string;
  mode?: string;
  isolation?: string;
  network?: string;
  timeout?: string;
  json?: boolean;
}

export async function runRoleAdd(root: string, name: string, options: RoleAddOptions, io: Io): Promise<number> {
  const scope = resolveScope(options);
  if (typeof scope !== "string") {
    printError(io, scope.error);
    return EXIT_USAGE;
  }

  const agents = (options.agents ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (agents.length === 0) {
    printError(io, 'Specify --agents a,b,c (at least one agent, comma-separated).');
    return EXIT_USAGE;
  }

  const mode = options.mode as TaskMode | undefined;
  if (!mode || !TASK_MODES.includes(mode)) {
    printError(io, `Invalid --mode (expected one of: ${TASK_MODES.join(", ")}).`);
    return EXIT_USAGE;
  }

  const isolation = (options.isolation ?? "auto") as Isolation | "auto";
  if (!ISOLATIONS.includes(isolation)) {
    printError(io, `Invalid --isolation (expected one of: ${ISOLATIONS.join(", ")}).`);
    return EXIT_USAGE;
  }

  const network = (options.network ?? "auto") as NetworkRequest;
  if (!NETWORK_REQUEST_VALUES.includes(network)) {
    printError(io, `Invalid --network (expected one of: ${NETWORK_REQUEST_VALUES.join(", ")}).`);
    return EXIT_USAGE;
  }

  let timeoutMs: number;
  try {
    timeoutMs = parseDuration(options.timeout ?? "10m");
  } catch (error) {
    printError(io, error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }

  const role: RoleConfig = {
    name,
    purpose: options.purpose ?? "",
    agents,
    mode,
    isolation,
    network,
    timeout_ms: timeoutMs,
  };

  const layer = await loadLayer(scope, root);
  const replaced = layer.roles?.some((r) => r.name === name) ?? false;
  const roles = [...(layer.roles ?? []).filter((r) => r.name !== name), role];
  await saveLayer(scope, root, { ...layer, roles });

  if (options.json) printJson(io, { role, replaced, scope });
  else printDone(io, `Role "${name}" ${replaced ? "replaced" : "created"} (${scopeLabel(scope)} layer).`);
  return EXIT_OK;
}
