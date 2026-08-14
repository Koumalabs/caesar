#!/usr/bin/env node
/**
 * Entry point of the `caesar-channel` binary: `caesar-channel <taskDir>`,
 * launched by a subagent like any local MCP server — see the task 9 brief.
 * `packages/core/src/engine/runner.ts` builds the command that launches it
 * dynamically (`resolveChannelEntry`), always passing `process.execPath` as
 * the command rather than this file directly: this binary therefore does not
 * need to be executable on its own for that usage, but keeps its shebang for
 * a direct launch (PATH, global link…).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildChannelServer } from "./server.js";

async function main(): Promise<void> {
  const taskDir = process.argv[2];
  if (!taskDir) {
    process.stderr.write("caesar-channel: missing task directory (usage: caesar-channel <taskDir>)\n");
    process.exitCode = 1;
    return;
  }

  const server = buildChannelServer(taskDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`caesar-channel: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
