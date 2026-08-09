/**
 * `orch agents list|enable|disable|test`.
 */
import type { AgentDefinition, Decision, OrchConfig } from "@orch/core";
import {
  checkDelegation,
  fileTaskStore,
  findAgentDefinition,
  findBinaryInPath,
  isAgentAllowed,
  isRecursionAllowed,
  listAgentDefinitions,
  loadConfig,
  runTask,
  saveProjectConfig,
} from "@orch/core";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, printError, printJson, renderTable, writeLine } from "../output.js";

/** Capacités notables d'un agent, en une poignée de libellés compacts (partagé avec `orch doctor`). */
export function describeAgentCapabilities(def: AgentDefinition): string[] {
  const caps: string[] = [];
  if (def.capabilities.nativeReadOnly) caps.push("lecture-seule native");
  if (def.capabilities.outputSchema) caps.push("schéma de sortie");
  if (def.capabilities.finalMessageFile) caps.push("message final fichier");
  if (def.capabilities.resume) caps.push("reprise");
  if (def.capabilities.addDir) caps.push("répertoires additionnels");
  if (def.capabilities.model) caps.push("choix du modèle");
  if (def.capabilities.mcpInjection !== "none") caps.push(`mcp:${def.capabilities.mcpInjection}`);
  return caps;
}

/**
 * Statut d'un agent vis-à-vis de la politique, hors profondeur de délégation
 * (qui n'a de sens que pour une tâche en cours — voir `pickAgentForRole`).
 * Partagé avec `orch doctor`.
 */
export function describeAgentPolicy(policy: OrchConfig["policy"], id: string): Decision {
  const allowedDecision = isAgentAllowed(policy, id);
  if (!allowedDecision.allowed) return allowedDecision;
  return isRecursionAllowed(policy, id);
}

export interface AgentsListOptions {
  json?: boolean;
}

export async function runAgentsList(root: string, options: AgentsListOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);
  const defs = listAgentDefinitions();

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
  ]);
  writeLine(io.stdout, renderTable(["agent", "binaire", "capacités", "politique"], tableRows));
  return EXIT_OK;
}

async function setAgentDenied(root: string, id: string, denied: boolean): Promise<OrchConfig> {
  const { config } = await loadConfig(root);
  const deniedSet = new Set(config.policy.denied);
  if (denied) deniedSet.add(id);
  else deniedSet.delete(id);
  const updated: OrchConfig = { ...config, policy: { ...config.policy, denied: [...deniedSet] } };
  await saveProjectConfig(root, updated);
  return updated;
}

export interface AgentsToggleOptions {
  json?: boolean;
}

function reportToggle(io: Io, options: AgentsToggleOptions, id: string, enabled: boolean, config: OrchConfig): number {
  if (options.json) {
    printJson(io, { id, enabled, denied: config.policy.denied });
  } else {
    writeLine(
      io.stdout,
      enabled ? `Agent "${id}" retiré de la liste "denied".` : `Agent "${id}" ajouté à la liste "denied".`,
    );
  }
  return EXIT_OK;
}

export async function runAgentsEnable(root: string, id: string, options: AgentsToggleOptions, io: Io): Promise<number> {
  const config = await setAgentDenied(root, id, false);
  return reportToggle(io, options, id, true, config);
}

export async function runAgentsDisable(root: string, id: string, options: AgentsToggleOptions, io: Io): Promise<number> {
  const config = await setAgentDenied(root, id, true);
  return reportToggle(io, options, id, false, config);
}

export interface AgentsTestOptions {
  yes?: boolean;
  json?: boolean;
}

/** Micro-tâche en lecture seule, utilisée pour vérifier qu'un agent répond effectivement. */
const PING_OBJECTIVE = "Réponds uniquement: OK";

export async function runAgentsTest(root: string, id: string, options: AgentsTestOptions, io: Io): Promise<number> {
  if (!findAgentDefinition(id)) {
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

  const { config } = await loadConfig(root);
  const decision = checkDelegation(config.policy, { agentId: id, depth: 0 });
  if (!decision.allowed) {
    printError(io, decision.reason);
    return EXIT_USAGE;
  }

  const store = fileTaskStore(root);
  const startedAt = Date.now();
  const outcome = await runTask(
    { store, root },
    {
      agentId: id,
      objective: PING_OBJECTIVE,
      mode: "read-only",
      isolation: "inplace",
      workspace: root,
      timeoutMs: 60_000,
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
