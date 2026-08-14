/**
 * `caesar channel serve --task-dir <dir>`: starts the return channel server
 * (`@caesar/mcp-channel`) on stdio, inside the `caesar` binary itself.
 *
 * Internal subcommand (task 12), masked from the help (`bin.ts`): it is not
 * meant to be typed by a human, only reached by self-invocation. The Bun
 * entry point (`bun-entry.ts`) hooks it into `@caesar/core` via
 * `configureChannelLauncher` — a compiled binary no longer has a
 * `node_modules` to resolve `@caesar/mcp-channel` from (see the brief). The
 * Node path never takes it by default: `defaultChannelLauncher`
 * (`packages/core/src/engine/runner.ts`) keeps resolving and launching
 * `@caesar/mcp-channel/dist/bin.js` as a separate subprocess, behavior
 * unchanged — this subcommand nevertheless exists in both worlds (same
 * commander program, see `bin.ts`), simply unused by the default Node path.
 *
 * Reuses the body of `packages/mcp-channel/src/bin.ts` (the standalone
 * `caesar-channel` binary, still resolved as-is by the Node path): same
 * server construction, same stdio transport. Nothing but the MCP protocol
 * writes to stdout here — same requirement as `caesar mcp serve` (see
 * `mcp.ts`).
 */
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildChannelServer } from "@caesar/mcp-channel";
import { EXIT_OK } from "../output.js";

export interface ChannelServeOptions {
  /** Test overrides: never set in real use (default: `process.stdin`/`process.stdout`, see `StdioServerTransport`). */
  stdin?: Readable;
  stdout?: Writable;
}

export async function runChannelServe(taskDir: string, options: ChannelServeOptions = {}): Promise<number> {
  const server = buildChannelServer(taskDir);
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  await server.connect(transport);
  return EXIT_OK;
}
