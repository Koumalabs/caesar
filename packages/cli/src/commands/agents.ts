/**
 * `orch agents list|enable|disable|test`.
 *
 * `describeAgentCapabilities`/`describeAgentPolicy` vivent dans `@orch/core`
 * (`registry/index.ts`, `policy.ts`) depuis le rapport de correction de la
 * tâche 8 — `packages/tui` en avait besoin pour son écran Agents, et les y
 * dupliquer ou faire dépendre le TUI du CLI pour deux fonctions pures était
 * pire que de les déplacer à côté de ce qu'elles décrivent. Ce module se
 * contente désormais de les appeler, comme `doctor.ts`.
 *
 * `enable`/`disable` écrivent une seule couche (`--global`/`--local`, projet
 * par défaut) via `materializePolicyList` (`@orch/core`, même mécanisme que
 * `orch policy allow|deny` — "denied" est le même champ) : jamais la fusion,
 * voir le brief de la tâche 13.
 */
import type { ConfigScope } from "@orch/core";
import {
  agentProvenance,
  checkDelegation,
  createQueue,
  describeAgentCapabilities,
  describeAgentPolicy,
  fileTaskStore,
  findAgentDefinition,
  findBinaryInPath,
  listAgentDefinitions,
  loadConfig,
  materializePolicyList,
  runTask,
} from "@orch/core";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, printError, printJson, renderTable, writeLine } from "../output.js";
import type { ScopeOptions } from "../scope.js";
import { materializationNotice, resolveScope, scopeLabel } from "../scope.js";

export interface AgentsListOptions {
  json?: boolean;
}

export async function runAgentsList(root: string, options: AgentsListOptions, io: Io): Promise<number> {
  const { config, layers } = await loadConfig(root);
  // Catalogue natif étendu des agents de configuration ([[agent]]) : voir C1
  // de la revue finale — sans quoi un agent déclaré en TOML restait invisible
  // de "orch agents list".
  const defs = listAgentDefinitions(config.agents);

  const rows = await Promise.all(
    defs.map(async (def) => {
      const path = await findBinaryInPath(def.bin);
      return {
        id: def.id,
        display_name: def.displayName,
        bin: def.bin,
        installed: path !== null,
        path: path ?? undefined,
        capabilities: describeAgentCapabilities(def),
        policy: describeAgentPolicy(config.policy, def.id),
        // "default" pour les cinq agents du catalogue natif : aucune couche ne les déclare, ils sont câblés dans le registre.
        provenance: agentProvenance(layers, def.id),
      };
    }),
  );

  if (options.json) {
    printJson(io, { agents: rows });
    return EXIT_OK;
  }

  const tableRows = rows.map((r) => [
    r.id,
    r.installed ? (r.path ?? "trouvé") : "absent",
    r.capabilities.join(", ") || "-",
    r.policy.allowed ? "autorisé" : `refusé (${r.policy.reason})`,
    r.provenance,
  ]);
  writeLine(io.stdout, renderTable(["agent", "binaire", "capacités", "politique", "provenance"], tableRows));
  return EXIT_OK;
}

export interface AgentsToggleOptions extends ScopeOptions {
  json?: boolean;
}

async function setAgentDenied(
  root: string,
  id: string,
  denied: boolean,
  options: AgentsToggleOptions,
): Promise<{ scope: ConfigScope; effective: string[]; materialized: boolean } | { error: string }> {
  const scope = resolveScope(options);
  if (typeof scope !== "string") return scope;
  const { effective, materialized } = await materializePolicyList(root, scope, "denied", id, denied);
  return { scope, effective, materialized };
}

function reportToggle(
  io: Io,
  options: AgentsToggleOptions,
  id: string,
  enabled: boolean,
  scope: ConfigScope,
  denied: string[],
  materialized: boolean,
): number {
  if (options.json) {
    printJson(io, { id, enabled, scope, denied, materialized });
  } else {
    writeLine(
      io.stdout,
      enabled
        ? `Agent "${id}" retiré de la liste "denied" (couche ${scopeLabel(scope)}).`
        : `Agent "${id}" ajouté à la liste "denied" (couche ${scopeLabel(scope)}).`,
    );
    if (materialized) writeLine(io.stdout, materializationNotice("denied", scope, denied));
  }
  return EXIT_OK;
}

export async function runAgentsEnable(root: string, id: string, options: AgentsToggleOptions, io: Io): Promise<number> {
  const result = await setAgentDenied(root, id, false, options);
  if ("error" in result) {
    printError(io, result.error);
    return EXIT_USAGE;
  }
  return reportToggle(io, options, id, true, result.scope, result.effective, result.materialized);
}

export async function runAgentsDisable(root: string, id: string, options: AgentsToggleOptions, io: Io): Promise<number> {
  const result = await setAgentDenied(root, id, true, options);
  if ("error" in result) {
    printError(io, result.error);
    return EXIT_USAGE;
  }
  return reportToggle(io, options, id, false, result.scope, result.effective, result.materialized);
}

export interface AgentsTestOptions {
  yes?: boolean;
  json?: boolean;
}

/** Micro-tâche en lecture seule, utilisée pour vérifier qu'un agent répond effectivement. */
const PING_OBJECTIVE = "Réponds uniquement: OK";

export async function runAgentsTest(root: string, id: string, options: AgentsTestOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);
  if (!findAgentDefinition(id, config.agents)) {
    printError(io, `Agent inconnu : "${id}".`);
    return EXIT_USAGE;
  }
  if (!options.yes) {
    printError(
      io,
      `"orch agents test" lance une vraie tâche et consomme le quota réel de l'agent "${id}". Ajoutez --yes pour confirmer.`,
    );
    return EXIT_USAGE;
  }

  const decision = checkDelegation(config.policy, { agentId: id, depth: 0 });
  if (!decision.allowed) {
    printError(io, decision.reason);
    return EXIT_USAGE;
  }

  const store = fileTaskStore(root);
  const queue = createQueue(config.policy.max_parallel);
  const startedAt = Date.now();
  const outcome = await runTask(
    { store, root, queue },
    {
      agentId: id,
      objective: PING_OBJECTIVE,
      mode: "read-only",
      isolation: "inplace",
      workspace: root,
      timeoutMs: 60_000,
      extraAgents: config.agents,
    },
  );
  const durationMs = Date.now() - startedAt;
  const responded = outcome.source !== "synthesized";

  if (options.json) {
    printJson(io, {
      agent: id,
      responded,
      duration_ms: durationMs,
      report_source: outcome.source,
      status: outcome.record.status,
      summary: outcome.report.summary,
    });
  } else if (responded) {
    writeLine(
      io.stdout,
      `Agent "${id}" a répondu en ${durationMs} ms (rapport récupéré au palier "${outcome.source}"). Résumé : ${outcome.report.summary}`,
    );
  } else {
    printError(
      io,
      `Agent "${id}" n'a produit aucun rapport exploitable en ${durationMs} ms (rapport synthétisé par défaut).`,
    );
  }

  return outcome.record.status === "succeeded" ? EXIT_OK : EXIT_RUNTIME;
}
