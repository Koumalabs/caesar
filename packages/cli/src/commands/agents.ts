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
import type { ConfigScope, GenericAgentSpec } from "@orch/core";
import {
  AGENT_DEFINITIONS,
  GENERIC_ARG_TOKENS,
  agentProvenance,
  checkDelegation,
  createSlotQueue,
  describeAgentCapabilities,
  describeAgentCapabilitiesShort,
  describeAgentPolicy,
  fileTaskStore,
  findAgentDefinition,
  findBinaryInPath,
  listAgentDefinitions,
  loadConfig,
  loadLayer,
  materializePolicyList,
  runTask,
  saveLayer,
  splitArgTemplate,
  validateGenericAgentSpec,
} from "@orch/core";
import type { Cell, Io } from "../output.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  homePath,
  printDone,
  printError,
  printHeading,
  printJson,
  printNote,
  printTable,
  sectionHeader,
  terminalWidth,
  wrapText,
  writeLine,
} from "../output.js";
import type { ScopeOptions } from "../scope.js";
import { materializationNotice, resolveScope, scopeFlagHint, scopeLabel } from "../scope.js";

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
        // Seulement pour la mise en forme : `capabilities` reste ce que
        // `--json` publie, en toutes lettres et inchangé.
        capabilitiesShort: describeAgentCapabilitiesShort(def),
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

  sectionHeader(io, "agents");

  // La raison d'un refus est une phrase entière : dans une cellule, elle
  // rognait la colonne « politique » à « refusé (Agent "c… » — donc à rien.
  // Elle descend sous le tableau, où elle a la place de se lire, comme le
  // fait déjà `orch doctor`.
  const tableRows: Cell[][] = rows.map((r) => [
    r.id,
    r.installed ? homePath(r.path ?? "trouvé") : { text: "absent", token: "bad" },
    { text: r.capabilitiesShort.join(" ") || "-", token: "dim" },
    r.policy.allowed ? { text: "autorisé", token: "ok" } : { text: "refusé", token: "bad" },
    { text: r.provenance, token: "dim" },
  ]);
  printTable(io, ["agent", "binaire", "capacités", "politique", "provenance"], tableRows);

  const denied = rows.filter((r) => !r.policy.allowed);
  if (denied.length > 0) {
    writeLine(io.stdout);
    printHeading(io, "refus");
    for (const r of denied) {
      if (r.policy.allowed) continue;
      for (const line of wrapText(`"${r.id}" : ${r.policy.reason}`, terminalWidth(io.stdout), "  - ", "    ")) {
        writeLine(io.stdout, line);
      }
    }
  }
  writeLine(io.stdout);
  for (const line of wrapText(
    'Capacités en toutes lettres : "orch doctor --verbose", ou "orch agents list --json".',
    terminalWidth(io.stdout),
  )) {
    printNote(io, line);
  }
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
    printDone(
      io,
      enabled
        ? `Agent "${id}" retiré de la liste "denied" (couche ${scopeLabel(scope)}).`
        : `Agent "${id}" ajouté à la liste "denied" (couche ${scopeLabel(scope)}).`,
    );
    if (materialized) printNote(io, materializationNotice("denied", scope, denied));
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

// ---------------------------------------------------------------------------
// Déclaration d'un agent (`[[agent]]`)
// ---------------------------------------------------------------------------

/**
 * Les cinq agents câblés dans le registre. Déclarer une entrée `[[agent]]`
 * portant l'un de ces identifiants est légitime — `listAgentDefinitions` fait
 * gagner la configuration sur le natif, délibérément — mais assez lourd de
 * conséquences (l'adaptateur natif, ses capacités et sa traduction
 * d'événements disparaissent au profit d'un lancement générique) pour être
 * signalé plutôt que subi.
 */
const NATIVE_IDS = new Set(AGENT_DEFINITIONS.map((def) => def.id));

/** Rappel des jetons substituables — l'aide de `--args` le cite (voir `program.ts`), plutôt qu'une seconde liste écrite à la main. */
export const ARG_TOKENS_HINT = GENERIC_ARG_TOKENS.map((name) => `{{${name}}}`).join(", ");

export interface AgentsAddOptions extends ScopeOptions {
  bin?: string;
  args?: string;
  displayName?: string;
  cwdMode?: string;
  readOnlyNative?: boolean;
  json?: boolean;
}

export async function runAgentsAdd(root: string, id: string, options: AgentsAddOptions, io: Io): Promise<number> {
  const scope = resolveScope(options);
  if (typeof scope !== "string") {
    printError(io, scope.error);
    return EXIT_USAGE;
  }

  const bin = options.bin?.trim();
  if (!bin) {
    printError(io, 'Précisez --bin <commande> : le binaire à lancer pour cet agent (par exemple --bin aider).');
    return EXIT_USAGE;
  }

  const cwdMode = options.cwdMode ?? "process";
  if (cwdMode !== "process" && cwdMode !== "flag") {
    printError(io, '--cwd-mode invalide (attendu "process" — le répertoire courant porte le workspace — ou "flag" — le workspace est déjà passé en argument).');
    return EXIT_USAGE;
  }

  let args: string[];
  try {
    args = splitArgTemplate(options.args ?? "{{prompt}}");
  } catch (error) {
    printError(io, error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }

  const spec: GenericAgentSpec = { id, bin, args, cwdMode };
  if (options.displayName !== undefined) spec.displayName = options.displayName;
  if (options.readOnlyNative) spec.capabilities = { nativeReadOnly: true };

  const invalid = validateGenericAgentSpec(spec);
  if (invalid) {
    printError(io, invalid);
    return EXIT_USAGE;
  }

  const layer = await loadLayer(scope, root);
  const replaced = layer.agents?.some((agent) => agent.id === id) ?? false;
  const agents = [...(layer.agents ?? []).filter((agent) => agent.id !== id), spec];
  await saveLayer(scope, root, { ...layer, agents });

  // Vérification d'installation *après* l'écriture, et jamais bloquante :
  // déclarer un agent pas encore installé est légitime (une machine, un
  // fichier de configuration partagé), mais l'apprendre au premier `orch run`
  // ne l'est pas.
  const binPath = await findBinaryInPath(bin);

  if (options.json) {
    printJson(io, { agent: spec, replaced, scope, bin_path: binPath, overrides_native: NATIVE_IDS.has(id) });
    return EXIT_OK;
  }

  printDone(io, `Agent "${id}" ${replaced ? "remplacé" : "déclaré"} (couche ${scopeLabel(scope)}).`);
  printNote(io, `  Ligne de commande : ${bin} ${args.join(" ")}`);
  if (NATIVE_IDS.has(id)) {
    writeLine(
      io.stdout,
      `Attention : "${id}" est un agent du catalogue natif. Cette déclaration le remplace — son adaptateur, ses capacités et sa traduction d'événements ne s'appliquent plus. Pour seulement l'autoriser ou le refuser, "orch agents disable ${id}".`,
    );
  }
  if (binPath === null) {
    // Le PATH n'est consulté que pour un nom simple : un chemin explicite
    // désigne un fichier (voir `findBinaryInPath`), et dire "introuvable dans
    // le PATH" enverrait alors chercher au mauvais endroit.
    const why = bin.includes("/")
      ? `n'existe pas ou n'est pas exécutable`
      : `est introuvable dans le PATH`;
    writeLine(io.stdout, `Le binaire "${bin}" ${why} : la déclaration est enregistrée, mais l'agent ne sera pas retenu tant qu'il ne le sera pas.`);
  }
  return EXIT_OK;
}

export interface AgentsRemoveOptions extends ScopeOptions {
  json?: boolean;
}

export async function runAgentsRemove(root: string, id: string, options: AgentsRemoveOptions, io: Io): Promise<number> {
  const scope = resolveScope(options);
  if (typeof scope !== "string") {
    printError(io, scope.error);
    return EXIT_USAGE;
  }

  const layer = await loadLayer(scope, root);
  if (!layer.agents?.some((agent) => agent.id === id)) {
    // Même limite que `orch role remove` : la fusion par clé (`mergeConfig`)
    // remplace, elle ne supprime jamais par absence. Retirer une entrée d'une
    // couche qui ne la déclare pas ne la ferait pas disparaître de la fusion —
    // un EXIT_OK mentirait sur ce qui vient de se passer.
    const { layers } = await loadConfig(root);
    const actual = agentProvenance(layers, id);
    if (actual === "default") {
      const hint = NATIVE_IDS.has(id)
        ? `il fait partie du catalogue natif : aucune couche ne le déclare, et rien ne le supprime. Pour l'écarter des délégations, "orch agents disable ${id}".`
        : `aucune couche ne le déclare : vérifiez l'identifiant avec "orch agents list".`;
      printError(io, `Rien à supprimer pour l'agent "${id}" : ${hint}`);
    } else {
      printError(
        io,
        `L'agent "${id}" n'est pas déclaré par la couche ${scopeLabel(scope)} : rien à supprimer ici, il vient de la couche ${scopeLabel(actual)} — réessayez avec ${scopeFlagHint(actual)}.`,
      );
    }
    return EXIT_USAGE;
  }

  const agents = layer.agents.filter((agent) => agent.id !== id);
  await saveLayer(scope, root, { ...layer, agents });

  if (options.json) {
    printJson(io, { id, removed: true, scope, restores_native: NATIVE_IDS.has(id) });
    return EXIT_OK;
  }
  printDone(io, `Agent "${id}" retiré (couche ${scopeLabel(scope)}).`);
  if (NATIVE_IDS.has(id)) printNote(io, `  L'adaptateur natif "${id}" reprend la main.`);
  return EXIT_OK;
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
  // Même verrou que `orch run` : cette sonde lance un vrai agent, elle compte
  // donc dans `max_parallel` comme n'importe quelle délégation.
  const queue = createSlotQueue({ root, limit: config.policy.max_parallel, label: `orch agents test ${id}` });
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
