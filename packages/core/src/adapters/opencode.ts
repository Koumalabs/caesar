import { join } from "node:path";
import type { ReportChannel, Task } from "@caesar/protocol";
import type {
  AgentCapabilities,
  AgentDefinition,
  BuildContext,
  PartialEvent,
  PreparedFile,
  SpawnPlan,
  Translation,
} from "../registry/types.js";
import { defaultPreferredReportChannel } from "../registry/types.js";
import { isRecord, parseJsonLine } from "./json-line.js";

const AGENT_ID = "opencode";

const CAPABILITIES: AgentCapabilities = {
  jsonEvents: true,
  outputSchema: false,
  finalMessageFile: false,
  nativeReadOnly: false,
  resume: true,
  addDir: false,
  mcpInjection: "project-config",
  model: true,
  // Aucun confinement dans la ligne de commande d'`opencode run` : le réseau
  // est ouvert et nous ne savons pas le refermer.
  network: "open",
};

/**
 * Config MCP projet, au format documenté par opencode (`opencode.json`, clé
 * `mcp`). Écrite à la racine du workspace — le seul emplacement où opencode
 * la découvre (`mcpInjection: "project-config"`, pas de flag pour lui en
 * désigner une autre, contrairement à `--mcp-config`/`--additional-mcp-config`
 * chez claude/copilot) : contrairement à eux, ce fichier n'est donc pas sous
 * `ctx.paths.dir`, qui appartient à l'orchestrateur.
 *
 * `restoreAfter: true` (voir C5 de la revue finale) : en isolation
 * `"inplace"`, `workspace` est le répertoire réel de l'utilisateur — sans ce
 * marqueur, un `opencode.json` existant y était écrasé silencieusement, sans
 * sauvegarde ni restauration, y compris pour une tâche en lecture seule.
 * `runAgentProcess` (`spawn.ts`) restaure le contenu précédent après
 * l'exécution, ou supprime le fichier s'il n'existait pas avant. Ce même
 * marqueur exclut aussi ce chemin du calcul de diff/recoupement
 * (`runner.ts`) : en isolation `worktree`, où ce fichier atterrit tout de
 * même dans l'arborescence du worktree jetable (`workspace` y vaut le
 * chemin du worktree), il ne doit pas se faire passer pour une écriture de
 * l'agent.
 */
function mcpConfigFile(workspace: string, channel: NonNullable<Task["channel"]>): PreparedFile {
  return {
    path: join(workspace, "opencode.json"),
    content:
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            [channel.server_name]: {
              type: "local",
              command: [channel.command, ...channel.args],
              enabled: true,
            },
          },
        },
        null,
        2,
      ) + "\n",
    restoreAfter: true,
  };
}

function build(ctx: BuildContext): SpawnPlan {
  const args: string[] = ["run", "--format", "json", "--dir", ctx.task.workspace];

  if (ctx.model) args.push("--model", ctx.model);
  // `task.role` porte le profil demandé ; opencode a son propre concept
  // d'agent nommé (persona/config), qui est le point d'accroche naturel.
  if (ctx.task.role) args.push("--agent", ctx.task.role);
  if (ctx.task.mode === "write") args.push("--auto");

  // Le prompt est positionnel et final ; les arguments bruts de l'utilisateur
  // passent après lui, en toute fin de ligne.
  args.push(ctx.prompt);
  args.push(...ctx.extraArgs);

  const files: PreparedFile[] = [];
  if (ctx.reportVia === "channel" && ctx.task.channel) {
    files.push(mcpConfigFile(ctx.task.workspace, ctx.task.channel));
  }

  return { command: "opencode", args, cwd: ctx.task.workspace, env: {}, files };
}

/**
 * Traduit le flux `opencode run --format json`.
 *
 * Toutes les formes traitées ici viennent de la capture réelle
 * (`test/fixtures/opencode.jsonl`, une tâche qui écrit un fichier et lance une
 * commande) : `step_start`, `text`, `step_finish`, et les parts `tool`.
 *
 * La version précédente cherchait un `part.type` préfixé `tool-`, un
 * `part.input` et un `part.state` de type chaîne — trois formes dérivées des
 * conventions du Vercel AI SDK, sur lequel opencode s'appuie, et **jamais
 * observées**. Aucune ne correspond : la forme réelle est `part.type ===
 * "tool"`, le nom dans `part.tool`, l'entrée et l'état dans `part.state`.
 * Aucun `tool_use` n'était donc émis, et un sous-agent opencode paraissait
 * n'utiliser aucun outil.
 *
 * Deux limites de ce flux, constatées plutôt que supposées : opencode ne
 * signale un outil qu'**une fois terminé** (jamais son départ, contrairement à
 * codex — un outil long y reste invisible tant qu'il tourne), et il ne signale
 * aucune fin de session, que le moteur déduit du code de sortie du processus.
 */
function translate(line: string): Translation {
  const data = parseJsonLine(line);
  if (!isRecord(data)) return { events: [] };

  const part = data["part"];
  if (!isRecord(part)) return { events: [] };
  const partType = part["type"];
  if (typeof partType !== "string") return { events: [] };

  if (partType === "text" && typeof part["text"] === "string") {
    const text = part["text"];
    return { events: [{ type: "message", text }], finalText: text };
  }

  if (partType === "tool") {
    const tool = typeof part["tool"] === "string" ? part["tool"] : "outil";
    const state = isRecord(part["state"]) ? part["state"] : undefined;
    // `state.title` est déjà le résumé qu'un humain veut lire — « ls -1 »,
    // « note.txt » — là où l'entrée sérialisée porte le contenu entier d'un
    // fichier écrit. On ne retombe sur celle-ci qu'à défaut de titre.
    const title = state && typeof state["title"] === "string" && state["title"] !== "" ? state["title"] : undefined;
    const input = state?.["input"];
    const summary = title ?? (input === undefined ? "" : JSON.stringify(input).slice(0, 200));
    // Seul "completed" a été observé ; les deux autres restent défensifs.
    const rawStatus = state?.["status"];
    const status = rawStatus === "completed" ? "succeeded" : rawStatus === "error" ? "failed" : "started";
    const callId = typeof part["callID"] === "string" ? part["callID"] : "";
    const events: PartialEvent[] = [{ type: "tool_use", tool, id: callId, input_summary: summary, status }];
    return { events };
  }

  return { events: [] };
}

export const opencodeAgent: AgentDefinition = {
  id: AGENT_ID,
  displayName: "OpenCode",
  bin: "opencode",
  capabilities: CAPABILITIES,
  preferredReportChannel: (_task: Task, channelAvailable: boolean): ReportChannel =>
    defaultPreferredReportChannel(CAPABILITIES, channelAvailable),
  build,
  translate,
};
