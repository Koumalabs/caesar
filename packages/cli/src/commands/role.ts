/**
 * `orch role list|show|add|remove`.
 *
 * `add`/`remove` écrivent une seule couche (`--global`/`--local`, projet par
 * défaut), jamais la fusion : voir le brief de la tâche 13. Contrairement
 * aux listes `allowed`/`denied` (`policy.ts`, `materializePolicyList`), un
 * rôle est une entrée à clé (`name`) qui se fusionne par remplacement entier
 * — pas de "matérialisation" à faire ici, `add` remplace directement
 * l'entrée de la couche visée. `remove` ne peut en revanche retirer qu'une
 * entrée que la couche visée déclare elle-même : un rôle hérité d'une
 * couche moins spécifique (ou du défaut) n'est pas modifiable en le
 * "retirant" d'une couche qui ne le porte pas — la fusion par clé ne sait
 * pas exprimer une suppression, seulement un remplacement (voir
 * `mergeConfig`) —, le dire clairement plutôt que de rendre EXIT_OK sans
 * rien avoir changé.
 */
import type { NetworkRequest, RoleConfig } from "@orch/core";
import { loadConfig, loadLayer, parseDuration, pickAgentForRole, resolveInstalledMap, resolveRole, roleProvenance, saveLayer } from "@orch/core";
import type { Isolation, TaskMode } from "@orch/protocol";
import { ISOLATIONS, NETWORK_REQUEST_VALUES, TASK_MODES } from "../flags.js";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_USAGE, printError, printJson, renderTable, writeLine } from "../output.js";
import type { ScopeOptions } from "../scope.js";
import { resolveScope, scopeFlagHint, scopeLabel } from "../scope.js";

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
  const { config, layers } = await loadConfig(root);
  const resolved = await resolveRole(config, root, name);
  if (!resolved) {
    printError(io, `Rôle inconnu : "${name}".`);
    return EXIT_USAGE;
  }
  const provenance = roleProvenance(layers, name);

  if (options.json) {
    printJson(io, { ...resolved, provenance });
    return EXIT_OK;
  }

  writeLine(io.stdout, `Rôle : ${resolved.name}`);
  writeLine(io.stdout, `Provenance : ${provenance}`);
  writeLine(io.stdout, `Intention : ${resolved.purpose || "(non précisée)"}`);
  writeLine(io.stdout, `Agents (ordre de repli) : ${resolved.agents.join(", ") || "(aucun)"}`);
  writeLine(io.stdout, `Mode : ${resolved.mode}`);
  writeLine(io.stdout, `Isolation : ${resolved.isolation}`);
  writeLine(io.stdout, `Réseau : ${resolved.network}`);
  writeLine(io.stdout, `Délai : ${resolved.timeout_ms} ms`);
  writeLine(io.stdout, "Prompt système :");
  writeLine(io.stdout, resolved.systemPrompt || "(aucun)");
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
    printError(io, `Rôle inconnu : "${name}".`);
    return EXIT_USAGE;
  }

  const layer = await loadLayer(scope, root);
  if (!layer.roles?.some((role) => role.name === name)) {
    // La fusion par clé (`mergeConfig`) remplace, elle ne supprime jamais par absence : retirer un rôle d'une
    // couche qui ne le déclare pas ne le ferait pas disparaître de la fusion (il resterait porté par la couche qui
    // le déclare réellement, ou par `defaultConfig()`) — un EXIT_OK ici mentirait sur ce qui vient de se passer.
    const actual = roleProvenance(layers, name);
    const hint =
      actual === "default"
        ? `il fait partie de la configuration par défaut : aucune couche ne le supprime, redéfinissez-le si vous voulez en changer le comportement.`
        : `il vient de la couche ${scopeLabel(actual)} : réessayez avec ${scopeFlagHint(actual)}.`;
    printError(io, `Le rôle "${name}" n'est pas déclaré par la couche ${scopeLabel(scope)} : rien à supprimer ici, ${hint}`);
    return EXIT_USAGE;
  }

  const roles = layer.roles.filter((role) => role.name !== name);
  await saveLayer(scope, root, { ...layer, roles });

  if (options.json) printJson(io, { name, removed: true, scope });
  else writeLine(io.stdout, `Rôle "${name}" supprimé (couche ${scopeLabel(scope)}).`);
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

  const network = (options.network ?? "auto") as NetworkRequest;
  if (!NETWORK_REQUEST_VALUES.includes(network)) {
    printError(io, `--network invalide (attendu l'une de : ${NETWORK_REQUEST_VALUES.join(", ")}).`);
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
  else writeLine(io.stdout, `Rôle "${name}" ${replaced ? "remplacé" : "créé"} (couche ${scopeLabel(scope)}).`);
  return EXIT_OK;
}
