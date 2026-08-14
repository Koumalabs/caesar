import type { ReportChannel, Task } from "@caesar/protocol";
import type { TaskPaths } from "@caesar/protocol";
import type { CaesarEventInput } from "@caesar/protocol";
import type { NetworkControl } from "../network.js";

/**
 * How the MCP return channel is wired on the agent side, when it is.
 *
 * - `"flag"`: one or more command-line options describe the server.
 * - `"project-config"`: a configuration file dropped into the workspace.
 * - `"global-config"`: the agent reads a configuration already present on the machine;
 *   nothing to inject at launch.
 * - `"none"`: the agent does not know how to speak MCP.
 */
export type McpInjection = "flag" | "project-config" | "global-config" | "none";

export interface AgentCapabilities {
  /** Emits an exploitable stream of JSON events. */
  jsonEvents: boolean;
  /** Knows how to natively constrain the shape of its final answer with a JSON Schema. */
  outputSchema: boolean;
  /** The CLI itself — and not the model — knows how to drop the final message into a file. */
  finalMessageFile: boolean;
  /** Has a read-only mode enforced by the CLI, and not by the prompt. */
  nativeReadOnly: boolean;
  resume: boolean;
  /** Accepts additional writable directories. */
  addDir: boolean;
  mcpInjection: McpInjection;
  model: boolean;
  /**
   * What the orchestrator knows how to control of this agent's network
   * access — and not what the agent is capable of. See `network.ts`:
   * `"open"` means "we do not know how to close it", not "it has the
   * network".
   *
   * It is the capability whose absence cost the most: `codex` ran
   * in a sandbox without network while three other agents had it
   * open, and no diagnostic said so.
   */
  network: NetworkControl;
}

export interface BuildContext {
  task: Task;
  paths: TaskPaths;
  /** Prompt already rendered by renderTaskPrompt, according to the selected tier. */
  prompt: string;
  reportVia: ReportChannel;
  /** Path of a JSON Schema already written to disk, when reportVia is "schema". */
  schemaFile?: string;
  /** Where the CLI must drop its final message, if it is capable of it. */
  finalMessageFile?: string;
  /**
   * Requested model (`--model`/`model:`), if there is one. Required — even
   * if that means passing `undefined` explicitly — rather than optional:
   * see C6 and the typing hardening of the final review. An optional field
   * is precisely what allowed `runTask` to omit this field without any
   * compilation error signaling it, while all five adapters consume it
   * (`ctx.model`): `--model` was accepted everywhere and silently ignored.
   * Absent → explicit `undefined`; each adapter only adds its flag if
   * `ctx.model` is defined.
   */
  model: string | undefined;
  /** Raw arguments added by the user, passed at the end of the line. */
  extraArgs: string[];
}

/** File the engine will have to write before launch (project MCP config, schema…). */
export interface PreparedFile {
  path: string;
  content: string;
  /**
   * True if this file must not outlive the task: its previous content
   * (if it had any) is restored once execution finishes; deleted if it
   * did not exist before. Reserved for files written into the user's
   * real workspace rather than into the task directory the orchestrator
   * already owns — see C5 of the final review (the opencode adapter,
   * the only one writing outside `ctx.paths.dir`): without this net,
   * `opencode.json` was overwritten silently, with neither backup nor
   * restoration, including in `inplace` isolation on the user's real
   * file. By default (absent or false), behavior unchanged: the file
   * remains after the task, useful for after-the-fact inspection (MCP
   * configs of claude/copilot, output schema…), all dropped under
   * `paths.dir`.
   */
  restoreAfter?: boolean;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
  /** Variables to add to the inherited environment. */
  env: Record<string, string>;
  files: PreparedFile[];
  stdin?: string;
}

/**
 * `Omit` does not distribute over union types: applied as-is to
 * `CaesarEventInput` (a union discriminated on `type`), it would keep only
 * the keys common to all variants — i.e. only `type`, losing
 * `text`, `tool`, `message`, etc. `DistributiveOmit` applies
 * `Omit` variant by variant to preserve each one's own fields,
 * which is the intention documented below.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Event without the common fields, which the engine will fill in. */
export type PartialEvent = DistributiveOmit<CaesarEventInput, "protocol" | "seq" | "at" | "task_id">;

export interface Translation {
  events: PartialEvent[];
  /** Final text of the agent carried by this line. The last one encountered wins. */
  finalText?: string;
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  bin: string;
  capabilities: AgentCapabilities;
  /** Report tier selected, from the most reliable to the most tolerant. */
  preferredReportChannel(task: Task, channelAvailable: boolean): ReportChannel;
  build(ctx: BuildContext): SpawnPlan;
  /** Translates an output line into the common vocabulary. Stateless. */
  translate(line: string): Translation;
}

/**
 * The report tier selection rule, common to all adapters:
 * the return channel takes precedence if it is available and the agent
 * knows how to hook into it, then the native JSON Schema, then as a last
 * resort the file report that any agent capable of writing a file can honor.
 */
export function defaultPreferredReportChannel(
  capabilities: AgentCapabilities,
  channelAvailable: boolean,
): ReportChannel {
  if (channelAvailable && capabilities.mcpInjection !== "none") return "channel";
  if (capabilities.outputSchema) return "schema";
  return "file";
}
