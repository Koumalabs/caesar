import type { ReportChannel, Task } from "@caesar/protocol";
import type { AgentCapabilities, AgentDefinition, BuildContext, SpawnPlan, Translation } from "./types.js";
import { defaultPreferredReportChannel } from "./types.js";

export interface GenericAgentSpec {
  id: string;
  displayName?: string;
  bin: string;
  /** Argument template. The tokens {{prompt}}, {{workspace}}, {{taskDir}}, {{reportPath}}, {{model}} are substituted. */
  args: string[];
  /** "process": the cwd carries the workspace. "flag": it is already in args. */
  cwdMode?: "process" | "flag";
  /**
   * Arguments added to the command line when the task is entitled to the
   * network — e.g. `--allow-all-urls`. Declaring them is promising that
   * *without* them the CLI is confined: that is what moves the network
   * capability from `"unknown"` to `"toggle"`. Same tokens as `args`.
   */
  networkArgs?: string[];
  capabilities?: Partial<AgentCapabilities>;
}

const NEUTRAL_CAPABILITIES: AgentCapabilities = {
  jsonEvents: false,
  outputSchema: false,
  finalMessageFile: false,
  nativeReadOnly: false,
  resume: false,
  addDir: false,
  mcpInjection: "none",
  model: false,
  // By default, we know nothing about the network of an arbitrary CLI — and
  // "knowing nothing" is neither "open" nor "closed". `createGenericAgent`
  // raises this to "toggle" as soon as the declaration carries `networkArgs`.
  network: "unknown",
};

/**
 * The tokens that `substitute` knows how to replace — hence the only ones an
 * argument template may carry. Exported because they are what
 * `validateGenericAgentSpec` validates and what the help of `caesar agents add`
 * and the TUI's Agents screen display: one single list, rather than three
 * copies that would diverge at the first token added.
 */
export const GENERIC_ARG_TOKENS = ["prompt", "workspace", "taskDir", "reportPath", "model"] as const;
export type GenericArgToken = (typeof GENERIC_ARG_TOKENS)[number];

const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;

/** Writes `{{name}}` — error messages speak of tokens in the form one types them. */
function tokenLiteral(name: string): string {
  return `{{${name}}}`;
}

function isGenericArgToken(name: string): name is GenericArgToken {
  return (GENERIC_ARG_TOKENS as readonly string[]).includes(name);
}

/** The token names carried by `template`, in order of appearance, duplicates included. */
function tokensIn(template: string): string[] {
  return [...template.matchAll(TOKEN_PATTERN)].map((match) => match[1] as string);
}

/**
 * Renders an argument template by substituting its tokens. If one of the
 * tokens it contains has no value — unknown, or known but without a value
 * for this task (`{{model}}` when no model is requested) — the whole
 * argument disappears rather than leaving an `undefined` or an empty
 * string in the command line.
 */
function substitute(template: string, tokens: Readonly<Record<GenericArgToken, string | undefined>>): string | undefined {
  let missing = false;
  const rendered = template.replace(TOKEN_PATTERN, (_match, name: string) => {
    const value = isGenericArgToken(name) ? tokens[name] : undefined;
    if (value === undefined) {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? undefined : rendered;
}

function buildGeneric(spec: GenericAgentSpec, cwdMode: "process" | "flag", ctx: BuildContext): SpawnPlan {
  // Typed on `GenericArgToken` — and not `Record<string, …>` — so that
  // `GENERIC_ARG_TOKENS` and the tokens actually substituted here cannot
  // diverge without `tsc` saying so: adding a token to the list without
  // giving it a value here becomes a compilation error, rather than a
  // token accepted at validation then silently absent at launch
  // (an argument whose token has no value disappears entirely).
  const tokens: Record<GenericArgToken, string | undefined> = {
    prompt: ctx.prompt,
    workspace: ctx.task.workspace,
    taskDir: ctx.paths.dir,
    reportPath: ctx.paths.reportPath,
    model: ctx.model,
  };

  const args: string[] = [];
  const templates = ctx.task.network ? [...spec.args, ...(spec.networkArgs ?? [])] : spec.args;
  for (const template of templates) {
    const rendered = substitute(template, tokens);
    if (rendered !== undefined) args.push(rendered);
  }
  args.push(...ctx.extraArgs);

  return {
    command: spec.bin,
    args,
    // "flag": the workspace is already carried by a token in args (e.g.
    // --dir {{workspace}}); the process runs from the task directory
    // rather than needlessly duplicating the cwd onto the workspace.
    cwd: cwdMode === "process" ? ctx.task.workspace : ctx.paths.dir,
    env: {},
    files: [],
  };
}

/**
 * Splits an argument template line into arguments, honoring single and
 * double quotes: `--system "you are {{prompt}}"` makes two arguments, not
 * three. The interfaces that declare an agent (`caesar agents
 * add --args`, the TUI's "arguments" field) enter a single line —
 * that is the form in which one reads a command line — whereas
 * `GenericAgentSpec.args` is a list: this function and
 * `formatArgTemplate` make the round trip, and live here rather than in
 * each of the two interfaces so that they cannot diverge.
 *
 * Throws on an unclosed quote: silence would produce a last argument
 * amputated of its delimiter, hence a command line different from the one
 * we think we wrote.
 */
export function splitArgTemplate(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      // An entirely empty argument between quotes ("") is still an argument:
      // `started` distinguishes it from the absence of an argument.
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote !== null) {
    throw new Error(`Unclosed ${quote === '"' ? "double" : "single"} quote in the arguments: ${input}`);
  }
  if (started) args.push(current);
  return args;
}

/** Inverse of `splitArgTemplate`: recomposes a readable line, quoting only what needs it. */
export function formatArgTemplate(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg === "") return '""';
      if (!/[\s"']/.test(arg)) return arg;
      // Double quotes by default; single if the argument already contains
      // a double quote — `splitArgTemplate` knows no escaping, so we
      // choose the delimiter rather than escape.
      return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
    })
    .join(" ");
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Checks that an agent declaration is usable, and returns the error
 * message to display rather than a boolean: the three ways of getting it
 * wrong all fail silently at runtime, which is precisely what must be
 * avoided.
 *
 *  - a misspelled token (`{{promt}}`) makes *the entire argument
 *    disappear* from the command line (see `substitute`);
 *  - a template without `{{prompt}}` launches the agent without ever
 *    passing it the task's objective — it answers, but beside the point;
 *  - an exotic identifier breaks resolution by name (`caesar run --agent`)
 *    and the role lists.
 *
 * Returns `null` when all is well. Does not check for the binary's
 * presence: that is the job of `findBinaryInPath`, and declaring an agent
 * not yet installed is legitimate.
 */
export function validateGenericAgentSpec(spec: GenericAgentSpec): string | null {
  if (spec.id.trim().length === 0) return "The agent identifier cannot be empty.";
  if (!ID_PATTERN.test(spec.id)) {
    return `Invalid agent identifier: "${spec.id}". Expected letters, digits, ".", "_" or "-", starting with a letter or a digit.`;
  }
  if (spec.bin.trim().length === 0) {
    return `Agent "${spec.id}" has no binary: specify the command to launch.`;
  }

  // The network arguments go through the same substitution as the others:
  // they therefore deserve the same check, without which a typo would make
  // them disappear silently — and the agent would depart without network
  // while announcing "network toggleable".
  const allArgs = [...spec.args, ...(spec.networkArgs ?? [])];
  const unknown = [...new Set(allArgs.flatMap(tokensIn).filter((name) => !isGenericArgToken(name)))];
  if (unknown.length > 0) {
    return (
      `Unknown token in the arguments of "${spec.id}": ${unknown.map(tokenLiteral).join(", ")}. ` +
      `Known: ${GENERIC_ARG_TOKENS.map(tokenLiteral).join(", ")}. ` +
      `An argument carrying a token without a value disappears entirely from the command line.`
    );
  }

  if (!spec.args.some((arg) => arg.includes(tokenLiteral("prompt")))) {
    return (
      `The arguments of "${spec.id}" do not contain ${tokenLiteral("prompt")}: ` +
      `the agent would be launched without ever receiving the task's objective.`
    );
  }

  return null;
}

/**
 * Builds an `AgentDefinition` for an arbitrary CLI, described
 * declaratively rather than by code. The output format of such a CLI is by
 * construction unknown: `translate` therefore never produces any event,
 * and the agent settles for the file report tier (unspecified
 * capabilities default to `false`, `mcpInjection` defaults to `"none"`).
 */
export function createGenericAgent(spec: GenericAgentSpec): AgentDefinition {
  const capabilities: AgentCapabilities = {
    ...NEUTRAL_CAPABILITIES,
    // `{{model}}` in the arguments *is* the entire support for model choice
    // for a generic agent: nothing else carries it. The capability is thus
    // deduced from it, instead of being declared separately — where it
    // would end up contradicting the arguments and announcing, in `caesar
    // agents list`, a model choice the command line passes nowhere.
    model: spec.args.some((arg) => arg.includes(tokenLiteral("model"))),
    // Same reasoning as for `model`: it is the `networkArgs` that
    // *constitute* the capability to open the network, nothing else carries it.
    // Deducing it here rather than letting it be declared separately avoids
    // an agent announcing "network toggleable" in `caesar doctor` while no
    // argument would open it.
    network: (spec.networkArgs?.length ?? 0) > 0 ? "toggle" : "unknown",
    ...spec.capabilities,
  };
  const cwdMode = spec.cwdMode ?? "process";

  return {
    id: spec.id,
    displayName: spec.displayName ?? spec.id,
    bin: spec.bin,
    capabilities,
    preferredReportChannel: (_task: Task, channelAvailable: boolean): ReportChannel =>
      defaultPreferredReportChannel(capabilities, channelAvailable),
    build: (ctx: BuildContext): SpawnPlan => buildGeneric(spec, cwdMode, ctx),
    translate: (): Translation => ({ events: [] }),
  };
}
