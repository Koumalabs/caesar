/**
 * `caesar_list_roles`: the configured roles, their intent, and the agent
 * that would be picked today for each one — see the task 7 brief.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { findAgentDefinition, findBinaryInPath, loadConfig, pickAgentForRole } from "@caesar/core";
import type { McpSession } from "../session.js";
import { jsonResult } from "./result.js";

export const CAESAR_LIST_ROLES = "caesar_list_roles";

export const caesarListRolesDescription =
  "List the roles configured for this project: their purpose, default mode (read-only or write), isolation and network policy, the model they request if any, " +
  "and — resolved right now against installed binaries and the current policy — which agent caesar_delegate would " +
  "actually pick if you passed this role, including the fallback chain and why any earlier candidate was " +
  "skipped. Use this to decide whether to delegate through a role (role=\"...\") or to name an agent directly " +
  "(agent=\"...\") in caesar_delegate.";

export async function caesarListRoles(session: McpSession): Promise<CallToolResult> {
  const { config } = await loadConfig(session.root);

  const roles = await Promise.all(
    config.roles.map(async (role) => {
      const installed = new Map<string, boolean>();
      await Promise.all(
        role.agents.map(async (id) => {
          // `config.agents`: a role may name a generic agent declared in
          // the configuration, not only the native catalog — see C1 of the
          // final review.
          const def = findAgentDefinition(id, config.agents);
          installed.set(id, def ? (await findBinaryInPath(def.bin)) !== null : false);
        }),
      );
      const pick = pickAgentForRole(role, { isInstalled: (id) => installed.get(id) ?? false, policy: config.policy });

      return {
        name: role.name,
        purpose: role.purpose,
        mode: role.mode,
        isolation: role.isolation,
        network: role.network,
        timeout_ms: role.timeout_ms,
        ...(role.model !== undefined ? { model: role.model } : {}),
        agents: role.agents,
        would_pick: "error" in pick ? null : pick.agentId,
        reason: "error" in pick ? pick.error : undefined,
        skipped: "error" in pick ? [] : pick.skipped,
      };
    }),
  );

  return jsonResult({ roles });
}

export function registerCaesarListRoles(server: McpServer, session: McpSession): void {
  server.registerTool(CAESAR_LIST_ROLES, { description: caesarListRolesDescription }, () => caesarListRoles(session));
}
