import { join } from "node:path";
import type { ReportChannel, Task } from "@orch/protocol";
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
};

/** Config MCP projet, au format documenté par opencode (`opencode.json`, clé `mcp`). */
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

function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Traduit le flux `opencode run --format json`.
 *
 * Les formes `step_start` / `text` / `step_finish` viennent de la capture
 * réelle (`test/fixtures/opencode.jsonl`). Le préfixe `tool-` sur
 * `part.type` est dérivé des conventions du Vercel AI SDK, sur lequel
 * opencode s'appuie ; il n'a pas été observé sur cette machine (le prompt de
 * capture n'a déclenché aucun outil) et reste strictement défensif. opencode
 * ne signale aucune fin de session dans son flux JSON : c'est au moteur de
 * la déduire du code de sortie du processus.
 */
function translate(line: string): Translation {
  const data = parseLine(line);
  if (!isRecord(data)) return { events: [] };

  const part = data["part"];
  if (!isRecord(part)) return { events: [] };
  const partType = part["type"];
  if (typeof partType !== "string") return { events: [] };

  if (partType === "text" && typeof part["text"] === "string") {
    const text = part["text"];
    return { events: [{ type: "message", text }], finalText: text };
  }

  if (partType.startsWith("tool-")) {
    const tool = partType.slice("tool-".length);
    const input = part["input"] ?? part["args"];
    const summary = input === undefined ? "" : JSON.stringify(input).slice(0, 200);
    const state = part["state"];
    const status = state === "output-available" ? "succeeded" : state === "output-error" ? "failed" : "started";
    const events: PartialEvent[] = [{ type: "tool_use", tool, input_summary: summary, status }];
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
