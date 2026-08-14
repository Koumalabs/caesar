import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { AgentDefinition } from "./types.js";
import { antigravityAgent } from "../adapters/antigravity.js";
import { claudeAgent } from "../adapters/claude.js";
import { codexAgent } from "../adapters/codex.js";
import { copilotAgent } from "../adapters/copilot.js";
import { opencodeAgent } from "../adapters/opencode.js";
import { createGenericAgent } from "./generic.js";
import type { GenericAgentSpec } from "./generic.js";
import { describeNetworkControl } from "../network.js";
import type { NetworkControl } from "../network.js";

const execFileAsync = promisify(execFile);

/** The catalog of natively known agents, in a stable order. */
export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  codexAgent,
  antigravityAgent,
  opencodeAgent,
  copilotAgent,
  claudeAgent,
];

/**
 * The native catalog, extended with the generic agents declared in
 * configuration (`CaesarConfig.agents`, `[[agent]]` section of the TOML) —
 * see C1 of the final review: until now, `createGenericAgent` was never
 * called in production, and an agent declared in configuration remained
 * invisible to `caesar run`, `caesar agents list`, `caesar doctor` and
 * `caesar_list_agents`.
 *
 * `extraAgents` wins in case of an identifier collision with the native
 * catalog (same rule as `mergeConfig`/`mergeByKey`, `config.ts`): an entry
 * `[[agent]] id = "codex"` would replace the native adapter of the same
 * name rather than being silently ignored.
 */
export function listAgentDefinitions(extraAgents: readonly GenericAgentSpec[] = []): readonly AgentDefinition[] {
  if (extraAgents.length === 0) return AGENT_DEFINITIONS;
  const merged = new Map<string, AgentDefinition>(AGENT_DEFINITIONS.map((agent) => [agent.id, agent] as const));
  for (const spec of extraAgents) merged.set(spec.id, createGenericAgent(spec));
  return [...merged.values()];
}

export function findAgentDefinition(id: string, extraAgents: readonly GenericAgentSpec[] = []): AgentDefinition | undefined {
  return listAgentDefinitions(extraAgents).find((agent) => agent.id === id);
}

/** Resolves an agent by identifier, native catalog and configuration agents combined. Throws if the identifier is unknown to both. */
export function resolveAgentDefinition(id: string, extraAgents: readonly GenericAgentSpec[] = []): AgentDefinition {
  const found = findAgentDefinition(id, extraAgents);
  if (!found) {
    const known = listAgentDefinitions(extraAgents).map((agent) => agent.id).join(", ");
    throw new Error(`Unknown agent: "${id}" (known: ${known})`);
  }
  return found;
}

/** Looks for an executable binary in the PATH, without spawning a process. */
export async function findBinaryInPath(bin: string): Promise<string | null> {
  // A `bin` containing a separator designates a file, not a name to look
  // up: that is the rule of `execvp` and of every shell, and it is the one
  // `spawn` already applies at launch. Without this case, `join(dir,
  // "/opt/my-cli")` produced "/usr/bin/opt/my-cli" for each directory
  // of the PATH, hence always `null` — an agent declared by absolute path
  // ran perfectly but was reported "absent" by `caesar doctor`,
  // `caesar agents list` and the TUI's Agents screen.
  if (bin.includes("/")) {
    try {
      await access(bin, constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }

  const pathVar = process.env["PATH"] ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Absent from this PATH directory: keep going.
    }
  }
  return null;
}

export interface AgentInstallStatus {
  id: string;
  bin: string;
  installed: boolean;
  path?: string;
  version?: string;
}

async function probeVersion(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 3000 });
    const version = stdout.trim().split("\n")[0]?.trim();
    return version || undefined;
  } catch {
    // No --version, a binary that answers badly, or the deadline exceeded:
    // the installation remains established by the presence in the PATH, the
    // version is simply absent.
    return undefined;
  }
}

/**
 * Detects whether an agent's binary is installed, and picks up its version
 * when the call is cheap (`--version`, time-bounded). Not part of this
 * detection: launching a real task, nor any CLI subcommand
 * (`caesar doctor` will come with the `cli` package).
 */
export async function detectAgentInstallation(def: AgentDefinition): Promise<AgentInstallStatus> {
  const path = await findBinaryInPath(def.bin);
  if (!path) {
    return { id: def.id, bin: def.bin, installed: false };
  }
  const version = await probeVersion(def.bin);
  return version === undefined
    ? { id: def.id, bin: def.bin, installed: true, path }
    : { id: def.id, bin: def.bin, installed: true, path, version };
}

/**
 * An agent's notable capabilities, as a handful of compact labels for
 * a human.
 *
 * Moved from `packages/cli/src/commands/agents.ts` (task 8, correction
 * report): `packages/tui` needed it for its Agents screen, and it is a
 * pure function over `AgentDefinition` — nothing facade-like. Bringing
 * it back here, next to the catalog it describes, avoids one facade
 * (TUI) depending on another (CLI) for two lines of logic, same
 * reasoning as `resolveDelegation` (`delegation.ts`) in the previous
 * task. `packages/cli` (`commands/agents.ts`, `commands/doctor.ts`)
 * now imports it from here.
 */
export function describeAgentCapabilities(def: AgentDefinition): string[] {
  // Network first, not last: it is the only capability always
  // present, and the most decisive for whether a task stands a chance
  // of succeeding. Last, it was also the first trimmed by the cap of
  // the "capabilities" column for the best-endowed agents — codex, the one
  // whose network surprises the most, lost exactly it.
  const caps: string[] = [describeNetworkControl(def.capabilities.network)];
  if (def.capabilities.nativeReadOnly) caps.push("native read-only");
  if (def.capabilities.outputSchema) caps.push("output schema");
  if (def.capabilities.finalMessageFile) caps.push("final message file");
  if (def.capabilities.resume) caps.push("resume");
  if (def.capabilities.addDir) caps.push("additional directories");
  if (def.capabilities.model) caps.push("model choice");
  if (def.capabilities.mcpInjection !== "none") caps.push(`mcp:${def.capabilities.mcpInjection}`);
  return caps;
}

/**
 * The same capabilities, as short markers.
 *
 * The spelled-out enumeration alone exceeds a terminal's width as soon as
 * an agent is well endowed: in an overview like `caesar doctor`, what one
 * looks for is the presence or absence of each capability, not its
 * wording. The two functions describe the same object and must stay
 * aligned: a capability added to one translates into the other (a test
 * checks this).
 */
export function describeAgentCapabilitiesShort(def: AgentDefinition): string[] {
  const caps: string[] = [SHORT_NETWORK[def.capabilities.network]];
  if (def.capabilities.nativeReadOnly) caps.push("ro");
  if (def.capabilities.outputSchema) caps.push("schema");
  if (def.capabilities.finalMessageFile) caps.push("msg");
  if (def.capabilities.resume) caps.push("resume");
  if (def.capabilities.addDir) caps.push("dirs");
  if (def.capabilities.model) caps.push("model");
  if (def.capabilities.mcpInjection !== "none") caps.push("mcp");
  return caps;
}

/**
 * Network markers, chosen to stand apart at a glance in a column: `net`
 * alone says "open", the other three carry a sign that calls for reading
 * the detail.
 */
const SHORT_NETWORK: Record<NetworkControl, string> = {
  open: "net",
  toggle: "net±",
  "write-only": "net(w)",
  unknown: "net?",
};

export {
  GENERIC_ARG_TOKENS,
  createGenericAgent,
  formatArgTemplate,
  splitArgTemplate,
  validateGenericAgentSpec,
  type GenericAgentSpec,
  type GenericArgToken,
} from "./generic.js";
export * from "./types.js";
