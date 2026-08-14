/**
 * MCP server construction: an SDK `McpServer`, with the ten delegation tools
 * registered — nine for the delegation itself (task 7 brief), plus
 * `caesar_answer` (return channel, task 9 brief).
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

/** Builds the MCP server for the project rooted at `root`, with its own session (running tasks, store). */
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
