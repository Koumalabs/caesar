/**
 * `orch role list|show|add|remove`.
 */
import type { OrchConfig, RoleConfig } from "@orch/core";
import { loadConfig, parseDuration, pickAgentForRole, resolveInstalledMap, resolveRole, saveProjectConfig } from "@orch/core";
import type { Isolation, TaskMode } from "@orch/protocol";
import { ISOLATIONS, TASK_MODES } from "../flags.js";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_USAGE, printError, printJson, renderTable, writeLine } from "../output.js";

/** Agents référencés par un ensemble de rôles, tous à la fois (`resolveInstalledMap` de `@orch/core` ne prend qu'une seule liste). */
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

  const tableRows = rows.map((r) => [r.name, r.agents.join(" > "), r.picked ?? `aucun (${r.error})`]);
  writeLine(io.stdout, renderTable(["rôle", "agents (ordre de repli)", "retenu aujourd'hui"], tableRows));
  return EXIT_OK;
}

export interface RoleShowOptions {
  json?: boolean;
}

export async function runRoleShow(root: string, name: string, options: RoleShowOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);
  const resolved = await resolveRole(config, root, name);
  if (!resolved) {
    printError(io, `Rôle inconnu : "${name}".`);
    return EXIT_USAGE;
  }

  if (options.json) {
    printJson(io, resolved);
    return EXIT_OK;
  }

  writeLine(io.stdout, `Rôle : ${resolved.name}`);
  writeLine(io.stdout, `Intention : ${resolved.purpose || "(non précisée)"}`);
  writeLine(io.stdout, `Agents (ordre de repli) : ${resolved.agents.join(", ") || "(aucun)"}`);
  writeLine(io.stdout, `Mode : ${resolved.mode}`);
  writeLine(io.stdout, `Isolation : ${resolved.isolation}`);
  writeLine(io.stdout, `Délai : ${resolved.timeout_ms} ms`);
  writeLine(io.stdout, "Prompt système :");
  writeLine(io.stdout, resolved.systemPrompt || "(aucun)");
  return EXIT_OK;
}

export interface RoleRemoveOptions {
  json?: boolean;
}

export async function runRoleRemove(root: string, name: string, options: RoleRemoveOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);
  if (!config.roles.some((role) => role.name === name)) {
    printError(io, `Rôle inconnu : "${name}".`);
    return EXIT_USAGE;
  }
  const updated: OrchConfig = { ...config, roles: config.roles.filter((role) => role.name !== name) };
  await saveProjectConfig(root, updated);

  if (options.json) printJson(io, { name, removed: true });
  else writeLine(io.stdout, `Rôle "${name}" supprimé.`);
  return EXIT_OK;
}

export interface RoleAddOptions {
  purpose?: string;
  agents?: string;
  mode?: string;
  isolation?: string;
  timeout?: string;
  json?: boolean;
}

export async function runRoleAdd(root: string, name: string, options: RoleAddOptions, io: Io): Promise<number> {
  const agents = (options.agents ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (agents.length === 0) {
    printError(io, 'Précisez --agents a,b,c (au moins un agent, séparés par des virgules).');
    return EXIT_USAGE;
  }

  const mode = options.mode as TaskMode | undefined;
  if (!mode || !TASK_MODES.includes(mode)) {
    printError(io, `--mode invalide (attendu l'une de : ${TASK_MODES.join(", ")}).`);
    return EXIT_USAGE;
  }

  const isolation = (options.isolation ?? "auto") as Isolation | "auto";
  if (!ISOLATIONS.includes(isolation)) {
    printError(io, `--isolation invalide (attendu l'une de : ${ISOLATIONS.join(", ")}).`);
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
    timeout_ms: timeoutMs,
  };

  const { config } = await loadConfig(root);
  const replaced = config.roles.some((r) => r.name === name);
  const updated: OrchConfig = {
    ...config,
    roles: [...config.roles.filter((r) => r.name !== name), role],
  };
  await saveProjectConfig(root, updated);

  if (options.json) printJson(io, { role, replaced });
  else writeLine(io.stdout, replaced ? `Rôle "${name}" remplacé.` : `Rôle "${name}" créé.`);
  return EXIT_OK;
}
