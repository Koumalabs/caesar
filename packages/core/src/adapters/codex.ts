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

/**
 * Traduit le flux `codex exec --json`.
 *
 * Les formes `thread.started` / `turn.started` / `item.completed` (items
 * `agent_message` et `error`) / `turn.completed` viennent de la capture
 * réelle (`test/fixtures/codex.jsonl`). `turn.failed`, `item.completed` avec
 * un item `command_execution`, et l'événement `error` de premier niveau sont
 * dérivés de la documentation publique de Codex ; ils n'ont pas été observés
 * sur cette machine et sont traités de façon strictement défensive.
 */
function translate(line: string): Translation {
  const data = parseJsonLine(line);
  if (!isRecord(data)) return { events: [] };

  const type = data["type"];
  if (typeof type !== "string") return { events: [] };

  if (type === "item.completed") {
    const item = data["item"];
    if (!isRecord(item)) return { events: [] };
    const itemType = item["type"];

    if (itemType === "agent_message" && typeof item["text"] === "string") {
      const text = item["text"];
      return { events: [{ type: "message", text }], finalText: text };
    }

    if (itemType === "error" && typeof item["message"] === "string") {
      const events: PartialEvent[] = [{ type: "error", message: item["message"], fatal: false }];
      return { events };
    }

    if (itemType === "command_execution") {
      const command = item["command"];
      const summary = typeof command === "string" ? command : Array.isArray(command) ? command.join(" ") : "";
      const status = item["status"];
      const events: PartialEvent[] = [
        {
          type: "tool_use",
          tool: "shell",
          input_summary: summary,
          status: status === "completed" ? "succeeded" : status === "failed" ? "failed" : "started",
        },
      ];
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
