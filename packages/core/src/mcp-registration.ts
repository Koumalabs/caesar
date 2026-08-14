/**
 * Registration of the orchestrator with the MCP clients (`claude`,
 * `codex`, `copilot`, `opencode`, `antigravity`): the per-client
 * installation plan, its application (native subcommand or file
 * write), and reading its current state.
 *
 * Moved from `packages/cli/src/commands/mcp.ts` (task 8, correction
 * report): `packages/tui` (Integrations screen) needed this
 * same logic, and making it depend on `packages/cli` to get it
 * created a cyclic workspace dependency with the `cli → tui` direction
 * that `caesar config` legitimately needs (dynamic resolution of the path of
 * `@caesar/tui`, never a static import). Bringing this module back here, next
 * to `config.ts`/`policy.ts`, restores a single dependency direction —
 * same reasoning as `resolveDelegation` (`delegation.ts`) in the previous
 * task.
 *
 * `packages/cli` (`commands/mcp.ts`) keeps a thin dressing over this
 * module: the CLI's own display format (`describePlan`/`planToJson`,
 * specific to `--json`/text) and the `Io`/exit-code shape of
 * `caesar mcp install`. This module knows neither — it
 * builds a plan, applies it, or reads a status, and nothing more.
 *
 * Note on `opencode` (inherited from the task 7 brief, taken over as
 * is): filed among the native-subcommand clients by that brief,
 * but `opencode mcp add --help` (verified on the development machine)
 * knows no non-interactive way to provide the command of a local stdio
 * server — only an interactive prompt. Automating it by guessing the
 * prompt sequence would be the invented flag the project's constraints
 * forbid; `opencode` is therefore treated here like the file-based clients.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { homeDirectory, isEnoent } from "./config.js";
import { writeFileAtomic } from "./fs-atomic.js";

const execFileAsync = promisify(execFile);

/** Name under which the orchestrator registers with each client — consistent with `ChannelSchema.server_name` (`@caesar/protocol`). */
export const SERVER_NAME = "caesar";

export const MCP_CLIENTS = ["claude", "codex", "copilot", "opencode", "antigravity"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export function isMcpClient(value: string): value is McpClient {
  return (MCP_CLIENTS as readonly string[]).includes(value);
}

function serveArgs(root: string): string[] {
  return ["mcp", "serve", "--root", root];
}

export interface CommandInstallPlan {
  client: McpClient;
  kind: "command";
  bin: string;
  args: string[];
}

export interface FileInstallPlan {
  client: McpClient;
  kind: "file";
  path: string;
  /** Key under which to merge `entry`, at the `SERVER_NAME` key — "mcpServers" (Copilot, Antigravity) or "mcp" (OpenCode). */
  mergeKey: string;
  entry: Record<string, unknown>;
}

export type InstallPlan = CommandInstallPlan | FileInstallPlan;

export function buildPlan(client: McpClient, root: string): InstallPlan {
  switch (client) {
    case "claude":
      return { client, kind: "command", bin: "claude", args: ["mcp", "add", SERVER_NAME, "--", "caesar", ...serveArgs(root)] };
    case "codex":
      return { client, kind: "command", bin: "codex", args: ["mcp", "add", SERVER_NAME, "--", "caesar", ...serveArgs(root)] };
    case "copilot":
      return {
        client,
        kind: "file",
        path: join(homeDirectory(), ".copilot", "mcp-config.json"),
        mergeKey: "mcpServers",
        entry: { type: "stdio", command: "caesar", args: serveArgs(root) },
      };
    case "antigravity":
      return {
        client,
        kind: "file",
        // Path given by the task 7 brief: this file already carries personal
        // user settings (including `trustedWorkspaces`),
        // preserved by the merge below (`applyPlan`).
        path: join(homeDirectory(), ".gemini", "antigravity-cli", "settings.json"),
        mergeKey: "mcpServers",
        entry: { command: "caesar", args: serveArgs(root) },
      };
    case "opencode":
      // "command" is an array for OpenCode, unlike the separate
      // "command"/"args" for Copilot and Antigravity.
      return {
        client,
        kind: "file",
        path: join(homeDirectory(), ".config", "opencode", "opencode.json"),
        mergeKey: "mcp",
        entry: { type: "local", command: ["caesar", ...serveArgs(root)], enabled: true },
      };
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return {};
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON file: ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Readable (indented) JSON serialization on top of `writeFileAtomic` (`fs-atomic.ts`). */
async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(data, null, 2) + "\n");
}

/** Never overwrites the file: only modifies the `mergeKey.caesar` key, everything else (including, for Antigravity, `trustedWorkspaces`) is preserved as-is. */
export async function applyPlan(plan: InstallPlan): Promise<void> {
  if (plan.kind === "command") {
    await execFileAsync(plan.bin, plan.args);
    return;
  }
  const existing = await readJsonFile(plan.path);
  const bucket = (existing[plan.mergeKey] as Record<string, unknown> | undefined) ?? {};
  const merged = { ...existing, [plan.mergeKey]: { ...bucket, [SERVER_NAME]: plan.entry } };
  await writeJsonFileAtomic(plan.path, merged);
}

/**
 * Registration state of an MCP client, used by the TUI's Integrations
 * screen (see the task 8 brief) — no "install" button that ignores
 * what is already in place.
 *
 * For the file-based clients (`copilot`, `antigravity`, `opencode`), the
 * state reads honestly: does the file exist, does it already carry the
 * `SERVER_NAME` entry? For the subcommand clients (`claude`, `codex`),
 * no reliable, side-effect-free read is available: `claude mcp
 * list` health-checks the approved servers (network side effect) and
 * publishes no `--json`; `codex mcp list --json` exists but remains
 * asymmetric with `claude`. Rather than guessing or invoking one and not the
 * other (the inconsistency would be worse than the missing info — see
 * global constraint #3 on unverified flags), `registered` is
 * `"unknown"` for both, with a reason naming the subcommand to
 * run oneself.
 */
export type McpRegistrationState = "registered" | "not-registered" | "unknown";

export interface McpStatus {
  client: McpClient;
  registered: McpRegistrationState;
  detail: string;
}

export async function checkMcpStatus(client: McpClient, root: string): Promise<McpStatus> {
  const plan = buildPlan(client, root);
  if (plan.kind === "command") {
    return {
      client,
      registered: "unknown",
      detail: `Status not verifiable without side effects: run "${plan.bin} mcp list" to check it yourself.`,
    };
  }

  const existing = await readJsonFile(plan.path);
  const bucket = existing[plan.mergeKey] as Record<string, unknown> | undefined;
  const registered = bucket !== undefined && Object.prototype.hasOwnProperty.call(bucket, SERVER_NAME);
  return {
    client,
    registered: registered ? "registered" : "not-registered",
    detail: registered ? `Already registered in ${plan.path}.` : `Absent from ${plan.path}.`,
  };
}
