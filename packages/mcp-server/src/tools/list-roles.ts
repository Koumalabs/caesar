/**
 * `caesar_list_roles` : les rôles configurés, leur intention, et l'agent qui
 * serait retenu aujourd'hui pour chacun — voir le brief de la tâche 7.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { findAgentDefinition, findBinaryInPath, loadConfig, pickAgentForRole } from "@caesar/core";
import type { McpSession } from "../session.js";
import { jsonResult } from "./result.js";

export const CAESAR_LIST_ROLES = "caesar_list_roles";

export const caesarListRolesDescription =
  "List the roles configured for this project: their purpose, default mode (read-only or write), isolation and network policy, " +
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
          // `config.agents` : un rôle peut nommer un agent générique déclaré
          // en configuration, pas seulement le catalogue natif — voir C1 de
          // la revue finale.
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
