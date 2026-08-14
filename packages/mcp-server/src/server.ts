/**
 * Construction du serveur MCP : un `McpServer` du SDK, avec les dix tools de
 * délégation enregistrés — neuf pour la délégation elle-même (brief de la
 * tâche 7), plus `caesar_answer` (canal retour, brief de la tâche 9).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSession } from "./session.js";
import type { McpSession } from "./session.js";
import { registerCaesarAnswer } from "./tools/answer.js";
import { registerCaesarApply } from "./tools/apply.js";
import { registerCaesarAwait } from "./tools/await.js";
import { registerCaesarCancel } from "./tools/cancel.js";
import { registerCaesarDelegate } from "./tools/delegate.js";
import { registerCaesarDiff } from "./tools/diff.js";
import { registerCaesarListAgents } from "./tools/list-agents.js";
import { registerCaesarListRoles } from "./tools/list-roles.js";
import { registerCaesarLogs } from "./tools/logs.js";
import { registerCaesarStatus } from "./tools/status.js";

const SERVER_NAME = "caesar";
const SERVER_VERSION = "0.1.0";

export interface BuiltServer {
  server: McpServer;
  session: McpSession;
}

/** Construit le serveur MCP pour le projet enraciné à `root`, avec sa propre session (tâches en cours, store). */
export async function buildServer(root: string): Promise<BuiltServer> {
  const session = await createSession(root);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerCaesarListAgents(server, session);
  registerCaesarListRoles(server, session);
  registerCaesarDelegate(server, session);
  registerCaesarAwait(server, session);
  registerCaesarStatus(server, session);
  registerCaesarLogs(server, session);
  registerCaesarCancel(server, session);
  registerCaesarDiff(server, session);
  registerCaesarApply(server, session);
  registerCaesarAnswer(server, session);

  return { server, session };
}
