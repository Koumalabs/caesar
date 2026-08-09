/**
 * `orch_list_agents` : le catalogue des providers connus, avec présence,
 * capacités et autorisation — voir le brief de la tâche 7.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { findBinaryInPath, isAgentAllowed, isRecursionAllowed, listAgentDefinitions, loadConfig } from "@orch/core";
import type { McpSession } from "../session.js";
import { jsonResult } from "./result.js";

export const ORCH_LIST_AGENTS = "orch_list_agents";

export const orchListAgentsDescription =
  "List every sub-agent provider the orchestrator knows about (codex, antigravity, opencode, copilot, claude): " +
  "whether its CLI is actually installed on this machine, what it can do (native read-only mode, structured " +
  "output, resumable sessions, model selection…), and whether the current policy would allow delegating to it " +
  "right now. Call this before orch_delegate when you are unsure which providers are usable, or when you want " +
  "to compare providers before running the same objective on several of them in parallel.";

export async function orchListAgents(session: McpSession): Promise<CallToolResult> {
  const { config } = await loadConfig(session.root);
  const defs = listAgentDefinitions();

  const agents = await Promise.all(
    defs.map(async (def) => {
      const path = await findBinaryInPath(def.bin);
      const allowedDecision = isAgentAllowed(config.policy, def.id);
      const policy = allowedDecision.allowed ? isRecursionAllowed(config.policy, def.id) : allowedDecision;

      return {
        id: def.id,
        display_name: def.displayName,
        bin: def.bin,
        installed: path !== null,
        path: path ?? undefined,
        capabilities: def.capabilities,
        policy: policy.allowed ? { allowed: true } : { allowed: false, reason: policy.reason },
      };
    }),
  );

  return jsonResult({ agents });
}

export function registerOrchListAgents(server: McpServer, session: McpSession): void {
  server.registerTool(ORCH_LIST_AGENTS, { description: orchListAgentsDescription }, () => orchListAgents(session));
}
