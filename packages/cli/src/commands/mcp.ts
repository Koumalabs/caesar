/**
 * `caesar mcp serve` and `caesar mcp install <client>`.
 *
 * `serve` starts the MCP server built by `@caesar/mcp-server` on the stdio
 * transport. Nothing but the protocol must touch stdout — the classic
 * mistake of this kind of server, which breaks it in obscure ways (see the
 * task 7 brief): every diagnostic (the greeting message included) goes to
 * `io.stderr`, never to `io.stdout`.
 *
 * `install` registers the orchestrator with an MCP client. The per-client
 * plan (native subcommand or configuration file), its application and the
 * reading of its state (`checkMcpStatus`, used by the TUI's Integrations
 * screen) live in `@caesar/core` (`mcp-registration.ts`, moved out of this
 * file in the task 8 correction report — `packages/tui` needed it without
 * depending on `packages/cli`). This module keeps only what is specific to
 * the CLI: `describePlan`/`planToJson` (the `--json`/text display format)
 * and the `Io` shape/exit codes of `caesar mcp install`.
 */
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "@caesar/mcp-server";
import type { InstallPlan } from "@caesar/core";
import { SERVER_NAME, applyPlan, buildPlan, isMcpClient, MCP_CLIENTS } from "@caesar/core";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, printDone, printError, printJson, printNote, writeLine } from "../output.js";

export { checkMcpStatus, MCP_CLIENTS, type McpClient, type McpRegistrationState, type McpStatus } from "@caesar/core";

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

export interface McpServeOptions {
  /** Test overrides: never set in real use (default: `process.stdin`/`process.stdout`, see `StdioServerTransport`). */
  stdin?: Readable;
  stdout?: Writable;
}

export async function runMcpServe(root: string, io: Io, options: McpServeOptions = {}): Promise<number> {
  const { server } = await buildServer(root);
  writeLine(io.stderr, `MCP server "${SERVER_NAME}" started (project root: ${root}). Listening on stdio…`);
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  await server.connect(transport);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

function describePlan(plan: InstallPlan): string {
  if (plan.kind === "command") {
    return `${plan.client}: would run "${[plan.bin, ...plan.args].join(" ")}".`;
  }
  return `${plan.client}: would write the "${SERVER_NAME}" entry into ${plan.path} (key "${plan.mergeKey}"), preserving the rest of the file.`;
}

function planToJson(plan: InstallPlan): Record<string, unknown> {
  return plan.kind === "command"
    ? { client: plan.client, action: "run-command", command: [plan.bin, ...plan.args] }
    : { client: plan.client, action: "write-file", file: plan.path, key: plan.mergeKey, entry: plan.entry };
}

export interface McpInstallOptions {
  dryRun?: boolean;
  json?: boolean;
}

export async function runMcpInstall(root: string, client: string, options: McpInstallOptions, io: Io): Promise<number> {
  if (!isMcpClient(client)) {
    printError(io, `Unknown MCP client: "${client}" (expected one of: ${MCP_CLIENTS.join(", ")}).`);
    return EXIT_USAGE;
  }

  const plan = buildPlan(client, root);

  if (options.dryRun) {
    if (options.json) printJson(io, { dry_run: true, ...planToJson(plan) });
    else printNote(io, `[dry-run] ${describePlan(plan)}`);
    return EXIT_OK;
  }

  try {
    await applyPlan(plan);
  } catch (error) {
    printError(io, `Installation failed for "${client}": ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_RUNTIME;
  }

  if (options.json) printJson(io, { dry_run: false, ...planToJson(plan) });
  else printDone(io, describePlan(plan));
  return EXIT_OK;
}
