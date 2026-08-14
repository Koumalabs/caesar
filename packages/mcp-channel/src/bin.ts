#!/usr/bin/env node
/**
 * Entry point of the return channel server: `dist/bin.js <taskDir>`,
 * launched by a subagent like any local MCP server — see the task 9 brief.
 * Not declared as a package `bin`: nothing resolves it by name, and the
 * shims would poison a fresh `pnpm install` with warnings (dist/ does not
 * exist until the first build). `packages/core/src/engine/runner.ts` builds
 * the command that launches it dynamically (`resolveChannelEntry`), always
 * passing `process.execPath` as the command rather than this file directly:
 * this file therefore does not need to be executable on its own, but keeps
 * its shebang for a direct launch by hand.
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
