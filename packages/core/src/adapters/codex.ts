import type { ReportChannel, Task } from "@orch/protocol";
import type {
  AgentCapabilities,
  AgentDefinition,
  BuildContext,
  PartialEvent,
  SpawnPlan,
  Translation,
} from "../registry/types.js";
import { defaultPreferredReportChannel } from "../registry/types.js";
import { isRecord, parseJsonLine } from "./json-line.js";

const AGENT_ID = "codex";

const CAPABILITIES: AgentCapabilities = {
  jsonEvents: true,
  outputSchema: true,
  finalMessageFile: true,
  nativeReadOnly: true,
  resume: true,
  addDir: true,
  mcpInjection: "flag",
  model: true,
  // Le bac à sable de codex n'expose son réglage réseau que sous
  // `sandbox_workspace_write` : il n'existe aucun `sandbox_read_only`, donc
  // `-s read-only` coupe le réseau sans recours. Vérifié sur codex 0.147.0.
  network: "write-only",
};

function build(ctx: BuildContext): SpawnPlan {
  const args: string[] = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    ctx.task.workspace,
    "-s",
    ctx.task.mode === "read-only" ? "read-only" : "workspace-write",
  ];

  // Le répertoire de tâche héberge le rapport et le message final ; il doit
  // rester accessible en écriture même quand le workspace, lui, est en lecture
  // seule.
  args.push("--add-dir", ctx.paths.dir);

  // `decideNetwork` ne laisse jamais `network` à vrai en lecture seule pour
  // cet agent : la clé n'existe que sous `sandbox_workspace_write`, et la
  // poser en `-s read-only` serait sans effet.
  if (ctx.task.network) args.push("-c", "sandbox_workspace_write.network_access=true");

  if (ctx.model) args.push("-m", ctx.model);
  if (ctx.reportVia === "schema" && ctx.schemaFile) {
    args.push("--output-schema", ctx.schemaFile);
  }
  if (ctx.finalMessageFile) args.push("-o", ctx.finalMessageFile);

  if (ctx.reportVia === "channel" && ctx.task.channel) {
    const { server_name, command, args: channelArgs } = ctx.task.channel;
    args.push("-c", `mcp_servers.${server_name}.command=${JSON.stringify(command)}`);
    args.push("-c", `mcp_servers.${server_name}.args=${JSON.stringify(channelArgs)}`);
  }

  // Le prompt est positionnel et final dans la grammaire de codex ; les
  // arguments bruts de l'utilisateur passent après lui, en toute fin de ligne.
  args.push(ctx.prompt);
  args.push(...ctx.extraArgs);

  return { command: "codex", args, cwd: ctx.task.workspace, env: {}, files: [] };
}

/** `kind` d'un `file_change` de codex → action du protocole. */
function fileAction(kind: unknown): "created" | "modified" | "deleted" | "renamed" {
  if (kind === "add") return "created";
  if (kind === "delete") return "deleted";
  if (kind === "rename") return "renamed";
  // "update" est la valeur observée pour une modification ; tout `kind`
  // inconnu tombe ici plutôt que de faire disparaître le fichier du journal.
  return "modified";
}

/** Traduit `item.status` en statut d'outil. Les deux premières valeurs sont observées. */
function toolStatus(status: unknown): "started" | "succeeded" | "failed" {
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  return "started";
}

/**
 * Traduit le flux `codex exec --json`.
 *
 * Formes observées dans la capture réelle (`test/fixtures/codex.jsonl`, une
 * tâche qui écrit un fichier et lance deux commandes) : `thread.started`,
 * `turn.started`, `item.started` et `item.completed` pour les items
 * `agent_message`, `command_execution` et `file_change`, et `turn.completed`.
 * L'item `error` vient d'une capture antérieure. `turn.failed` et
 * l'événement `error` de premier niveau restent dérivés de la documentation
 * publique, jamais observés, traités de façon strictement défensive.
 *
 * Volontairement absent : l'item `reasoning`. La capture porte bien
 * `reasoning_output_tokens: 91` dans son `turn.completed`, mais **aucun item
 * de ce type n'a été émis** — écrire la branche à l'aveugle est exactement
 * l'erreur qui a rendu inopérante celle d'opencode pendant des mois.
 */
function translate(line: string): Translation {
  const data = parseJsonLine(line);
  if (!isRecord(data)) return { events: [] };

  const type = data["type"];
  if (typeof type !== "string") return { events: [] };

  // `item.started` autant qu'`item.completed` : c'est toute la différence
  // entre voir partir un `npm install` de trois minutes et le découvrir à la
  // troisième. `item.updated` suit la même forme et est traité pareil.
  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const completed = type === "item.completed";
    const item = data["item"];
    if (!isRecord(item)) return { events: [] };
    const itemType = item["type"];

    if (itemType === "agent_message" && completed && typeof item["text"] === "string") {
      const text = item["text"];
      return { events: [{ type: "message", text }], finalText: text };
    }

    if (itemType === "error" && completed && typeof item["message"] === "string") {
      const events: PartialEvent[] = [{ type: "error", message: item["message"], fatal: false }];
      return { events };
    }

    if (itemType === "command_execution") {
      const command = item["command"];
      const summary = typeof command === "string" ? command : Array.isArray(command) ? command.join(" ") : "";
      const events: PartialEvent[] = [
        {
          type: "tool_use",
          tool: "shell",
          id: typeof item["id"] === "string" ? item["id"] : "",
          input_summary: summary,
          status: toolStatus(item["status"]),
        },
      ];
      return { events };
    }

    if (itemType === "file_change") {
      // Seulement à l'achèvement : un `file_change` est instantané et sa forme
      // `item.started` porte exactement les mêmes changements — les émettre
      // deux fois ferait apparaître chaque fichier en double dans le journal.
      if (!completed) return { events: [] };
      const changes = item["changes"];
      if (!Array.isArray(changes)) return { events: [] };
      const events: PartialEvent[] = [];
      for (const change of changes) {
        if (!isRecord(change) || typeof change["path"] !== "string") continue;
        events.push({ type: "file_changed", path: change["path"], action: fileAction(change["kind"]) });
      }
      return { events };
    }

    return { events: [] };
  }

  if (type === "turn.completed") {
    return { events: [{ type: "finished", status: "success", summary: "", exit_code: null }] };
  }

  if (type === "turn.failed") {
    return { events: [{ type: "finished", status: "failed", summary: "", exit_code: null }] };
  }

  if (type === "error" && typeof data["message"] === "string") {
    return { events: [{ type: "error", message: data["message"], fatal: true }] };
  }

  return { events: [] };
}

export const codexAgent: AgentDefinition = {
  id: AGENT_ID,
  displayName: "Codex",
  bin: "codex",
  capabilities: CAPABILITIES,
  preferredReportChannel: (_task: Task, channelAvailable: boolean): ReportChannel =>
    defaultPreferredReportChannel(CAPABILITIES, channelAvailable),
  build,
  translate,
};
