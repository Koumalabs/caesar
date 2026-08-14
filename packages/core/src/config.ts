/**
 * Orchestrator configuration: schema, loading, merging and writing.
 *
 * Three locations on disk, merged at load time in this order — the most
 * specific one winning, field by field:
 *   - global  : `~/.config/caesar/config.toml`               (not versioned, machine-specific)
 *   - project : `<root>/.caesar/config.toml`                 (versioned, shared with the team)
 *   - local   : `<root>/.caesar/config.local.toml`            (not versioned, machine-specific — to be added to `.gitignore`)
 *
 * `@caesar/core` is the single source of truth for this configuration (see
 * the project's global constraints): no facade (CLI, TUI, MCP server)
 * may re-read or rewrite the TOML on its own behalf, they all go
 * through this module.
 *
 * The merge (`mergeConfig`, called by `loadConfig`) remains the single source
 * of truth for what a consumer (engine, MCP server, roles, policy)
 * must read — `loadConfig(...).config`. **Writing**, however, must never
 * rewrite the result of this merge into a single layer: that would freeze
 * into it the values of all the less specific layers, which would then
 * lose all effect (this was defect I11 of the final branch review).
 * `loadLayer`/`saveLayer` therefore give access to one precise layer, isolated
 * from the merge: an absent file yields an empty `ConfigOverride`, never an
 * error nor default values, and `saveLayer` serializes only what the
 * caller gives it explicitly — never more than what the layer must
 * declare.
 *
 * The configuration is a hand-edited file: validation errors
 * systematically name the file and the field at fault, and
 * an absent file is never an error (see `loadConfig`).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ZodIssue } from "zod";
import { z } from "zod";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";
import type { Isolation, TaskMode } from "@caesar/protocol";
import { TaskModeSchema } from "@caesar/protocol";
import type { GenericAgentSpec } from "./registry/generic.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { NETWORK_REQUESTS } from "./network.js";
import type { NetworkRequest } from "./network.js";

export interface PolicyConfig {
  allowed: string[];
  denied: string[];
  max_parallel: number;
  default_isolation: Isolation | "auto";
  default_mode: TaskMode;
  default_network: NetworkRequest;
  default_timeout_ms: number;
  allow_recursion: boolean;
  /**
   * Allows a write task to run directly in the working tree
   * (`isolation = "inplace"`) even though a worktree would be possible.
   *
   * False by default, and that is the whole point of the setting:
   * `decideInplaceWrite` (`isolation.ts`) refuses this combination, because
   * it mingles the sub-agent's modifications with the user's and with
   * those of the other tasks, out of reach of `caesar diff`. The opt-in exists
   * for repositories where the user knowingly accepts this mixing —
   * never as an answer to an incomplete worktree, whose remedy is the
   * `[worktree]` section.
   */
  allow_inplace_write: boolean;
  max_depth: number;
}

/**
 * `[worktree]`: what must be added to an isolated task's worktree so
 * that one can actually work in it.
 *
 * A git worktree only contains **tracked** files. Everything else —
 * installed dependencies, `.env`, ignored directories carrying briefs or
 * artifacts — is absent from it, so much so that isolation was often
 * literally unusable: nothing installed there, nothing launched there,
 * and bypassing it with `isolation = "inplace"` remained the only
 * practicable way out. That is the root cause of the defect this module and
 * `isolation.ts` fix together: hardening the rule without making the worktree
 * habitable would only have displaced the workaround.
 *
 * Deliberately outside `[policy]`: this is not a governance trade-off
 * — who is allowed to do what — but a description of the project, in the same
 * way as the list of its agents. Nothing here grants or denies anything.
 */
export interface WorktreeConfig {
  /**
   * Paths copied from the workspace into the worktree, relative to the root.
   * Isolated: what the sub-agent writes there does not touch the original. On
   * a copy-on-write filesystem (APFS, Btrfs, XFS…), nothing is
   * actually duplicated as long as nobody writes — see `copyTree`
   * (`engine/materialize.ts`) for the measurements.
   */
  copy: string[];
  /**
   * Paths **linked** rather than copied — shared, therefore not isolated: two
   * simultaneous tasks write into the same directory, and what they break
   * there, they break for the workspace. Last resort, when copying is
   * prohibitively expensive for lack of copy-on-write; the task then reports
   * it in its report rather than keeping quiet about it.
   */
  link: string[];
  /**
   * Commands run in the worktree after its creation and
   * materialization, before the sub-agent starts — the "Project
   * Setup" step of the `superpowers:using-git-worktrees` skill. A failure
   * fails the task: better not to start than to open a half-assembled
   * workshop to the agent.
   */
  setup: string[];
}

export interface RoleConfig {
  name: string;
  purpose: string;
  agents: string[];
  mode: TaskMode;
  isolation: Isolation | "auto";
  network: NetworkRequest;
  timeout_ms: number;
  system_prompt_file?: string;
}

export interface CaesarConfig {
  policy: PolicyConfig;
  worktree: WorktreeConfig;
  roles: RoleConfig[];
  agents: GenericAgentSpec[];
}

/**
 * A contribution to merge into a base `CaesarConfig` — what `mergeConfig`
 * accepts as `override`, and what a single configuration file (global or
 * project) contributes once parsed.
 *
 * `policy` is deliberately `Partial<PolicyConfig>`, not `PolicyConfig`:
 * `Partial<CaesarConfig>` would only have made it superficially optional at
 * the level of `policy` itself, requiring it to be complete as soon as it is
 * present — whereas the intended (and tested) merge is field by field. `roles`
 * and `agents` remain lists of complete entries: those two merge
 * by key, with whole-entry replacement (see `mergeConfig`),
 * not field by field.
 */
export interface ConfigOverride {
  policy?: Partial<PolicyConfig>;
  /**
   * `Partial<WorktreeConfig>` for the same reason as `policy`: the merge is
   * done field by field, a file that declares `setup` without `copy` says
   * nothing about `copy`. Each present field **replaces** the previous
   * layer's, never adds to it: a union would make it impossible to
   * locally remove an entry inherited from the global layer, whereas that is
   * precisely the use case of the local layer.
   */
  worktree?: Partial<WorktreeConfig>;
  roles?: RoleConfig[];
  agents?: GenericAgentSpec[];
}

/** The three layers, from most general to most specific — see this module's header. */
export type ConfigScope = "global" | "project" | "local";

/** A layer as it exists on disk: `override` is exactly what the file declares, never the result of a merge (see `loadLayer`). */
export interface ConfigLayer {
  scope: ConfigScope;
  path: string;
  override: ConfigOverride;
}

export interface LoadedConfig {
  config: CaesarConfig;
  /** The three layers, in application order (global, project, local) — including those whose file is absent (`override` empty then). */
  layers: ConfigLayer[];
  sources: { global?: string; project?: string; local?: string };
  /**
   * Reserved for non-blocking warnings (file loaded but carrying
   * a minor inconsistency). No condition of that kind is
   * produced yet by this task: always empty for now.
   */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const DURATION_PATTERN = /^(\d+)(ms|s|m|h)?$/;
const DURATION_FACTORS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const DURATION_HELP = 'accepted forms: "10m", "90s", "1h", or an integer number of milliseconds';

/** Converts a TOML duration ("10m", "90s", "1h", or an integer number of milliseconds) into milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid duration: ${value} (${DURATION_HELP})`);
    }
    return Math.trunc(value);
  }
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match || !match[1]) {
    throw new Error(`Invalid duration: "${value}" (${DURATION_HELP})`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  return amount * DURATION_FACTORS[unit]!;
}

// ---------------------------------------------------------------------------
// Raw schema: the shape as it appears in the TOML
// ---------------------------------------------------------------------------

const DurationInputSchema = z.union([z.string(), z.number()]);

/** Required TOML duration, with a default value if the field is absent. */
function requiredDurationMsSchema(defaultValue: string | number) {
  return DurationInputSchema.default(defaultValue).transform((value, ctx) => {
    try {
      return parseDuration(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
      return z.NEVER;
    }
  });
}

/**
 * Optional TOML duration, which stays `undefined` if the field is absent —
 * used only for `policy`, whose fields merge one by one
 * between the global and the project (see `mergeConfig`): a field absent from
 * one file must never overwrite the other's value with a default
 * value applied too early.
 */
function optionalDurationMsSchema() {
  return DurationInputSchema.optional().transform((value, ctx) => {
    if (value === undefined) return undefined;
    try {
      return parseDuration(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
      return z.NEVER;
    }
  });
}

const IsolationOrAutoSchema = z.enum(["inplace", "worktree", "auto"]);
const NetworkRequestSchema = z.enum(NETWORK_REQUESTS);

/**
 * `[policy]`: each field remains optional here. A file that does not
 * mention a field says nothing about it — it is `mergeConfig` that
 * decides, by falling it back to the previous layer (global, then
 * `defaultConfig()`). Defaulting the field here would lose that
 * distinction between "absent" and "explicitly set to the default
 * value".
 */
const RawPolicySchema = z
  .object({
    allowed: z.array(z.string()).optional(),
    denied: z.array(z.string()).optional(),
    max_parallel: z.number().int().positive().optional(),
    default_isolation: IsolationOrAutoSchema.optional(),
    default_mode: TaskModeSchema.optional(),
    default_network: NetworkRequestSchema.optional(),
    default_timeout: optionalDurationMsSchema(),
    allow_recursion: z.boolean().optional(),
    allow_inplace_write: z.boolean().optional(),
    max_depth: z.number().int().nonnegative().optional(),
  })
  .strict();
type RawPolicy = z.infer<typeof RawPolicySchema>;

/**
 * A `[worktree] copy`/`link` path: relative to the workspace root,
 * staying inside it, and touching neither `.git` nor `.caesar`.
 *
 * Validated here rather than at materialization, because an invalid entry is
 * a configuration error, not an execution circumstance: it must show
 * up when the file is loaded, with its name and its line, not turn
 * later into a task that fails. The three prohibitions:
 *
 * - **absolute**: would point to some arbitrary elsewhere on the machine;
 * - **`..`**: would leave the workspace, hence the perimeter that isolation
 *   promises to contain;
 * - **`.git` / `.caesar`**: copying or linking either would make the
 *   sub-agent write into the administration of the repository or of the
 *   orchestrator — exactly what the worktree exists not to touch.
 */
const WorktreePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value), {
    message: "absolute path forbidden: paths are relative to the workspace root",
  })
  .refine((value) => !value.split(/[\\/]/).includes(".."), {
    message: '".." segment forbidden: a path cannot leave the workspace',
  })
  .refine((value) => {
    const first = value.split(/[\\/]/)[0];
    return first !== ".git" && first !== ".caesar";
  }, { message: '".git" and ".caesar" are excluded: they are the administration of the repository and of caesar' });

/**
 * `[worktree]`: same rules as `[policy]` — each field optional, the
 * merge decides. See `WorktreeConfig`.
 */
const RawWorktreeSchema = z
  .object({
    copy: z.array(WorktreePathSchema).optional(),
    link: z.array(WorktreePathSchema).optional(),
    setup: z.array(z.string().min(1)).optional(),
  })
  .strict();
type RawWorktree = z.infer<typeof RawWorktreeSchema>;

/**
 * `[[role]]`: unlike `policy`, a project role bearing the same
 * `name` as a global role replaces the latter **entirely** (merge by
 * key, not field by field — see `mergeConfig`). Each entry must therefore
 * be complete by itself; its default fields are thus applied
 * here, locally to the entry.
 */
const RawRoleSchema = z
  .object({
    name: z.string().min(1),
    purpose: z.string().default(""),
    agents: z.array(z.string()),
    mode: TaskModeSchema,
    isolation: IsolationOrAutoSchema.default("auto"),
    network: NetworkRequestSchema.default("auto"),
    timeout: requiredDurationMsSchema("10m"),
    system_prompt_file: z.string().optional(),
  })
  .strict();
type RawRole = z.infer<typeof RawRoleSchema>;

/**
 * `[[agent]]`: custom agent, cf. `GenericAgentSpec`. Merge by key
 * (`id`), same logic as roles.
 *
 * `native_read_only` is the only capability declarable here, and that is
 * deliberate: it is the only one the engine honors without the command-line
 * construction having to cooperate (`runner.ts` uses it to decide whether
 * a read-only task must be isolated in a worktree). The others —
 * output schema, MCP injection, final message as a file, event
 * stream — assume the adapter passes something to the target CLI,
 * which `buildGeneric` does not do: making them declarable would amount to
 * letting a report channel be promised that nothing wires up, and to making
 * the task fail further along, unrelated to the box that was ticked. The
 * model choice, for its part, is deduced from the presence of `{{model}}` in
 * the arguments (see `createGenericAgent`) rather than declared.
 */
const RawAgentSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1).optional(),
    bin: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd_mode: z.enum(["process", "flag"]).optional(),
    native_read_only: z.boolean().optional(),
    network_args: z.array(z.string()).optional(),
  })
  .strict();
type RawAgent = z.infer<typeof RawAgentSchema>;

const RawFileSchema = z
  .object({
    policy: RawPolicySchema.optional(),
    worktree: RawWorktreeSchema.optional(),
    role: z.array(RawRoleSchema).default([]),
    agent: z.array(RawAgentSchema).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Conversions between the raw shape (TOML) and the applicative shape (CaesarConfig)
// ---------------------------------------------------------------------------

/** Keeps only the fields actually present: this is what makes the field-by-field `policy` merge possible. */
function toPolicyOverride(raw: RawPolicy): Partial<PolicyConfig> {
  const override: Partial<PolicyConfig> = {};
  if (raw.allowed !== undefined) override.allowed = raw.allowed;
  if (raw.denied !== undefined) override.denied = raw.denied;
  if (raw.max_parallel !== undefined) override.max_parallel = raw.max_parallel;
  if (raw.default_isolation !== undefined) override.default_isolation = raw.default_isolation;
  if (raw.default_mode !== undefined) override.default_mode = raw.default_mode;
  if (raw.default_network !== undefined) override.default_network = raw.default_network;
  if (raw.default_timeout !== undefined) override.default_timeout_ms = raw.default_timeout;
  if (raw.allow_recursion !== undefined) override.allow_recursion = raw.allow_recursion;
  if (raw.allow_inplace_write !== undefined) override.allow_inplace_write = raw.allow_inplace_write;
  if (raw.max_depth !== undefined) override.max_depth = raw.max_depth;
  return override;
}

/** Same contract as `toPolicyOverride`: only the fields actually declared. */
function toWorktreeOverride(raw: RawWorktree): Partial<WorktreeConfig> {
  const override: Partial<WorktreeConfig> = {};
  if (raw.copy !== undefined) override.copy = raw.copy;
  if (raw.link !== undefined) override.link = raw.link;
  if (raw.setup !== undefined) override.setup = raw.setup;
  return override;
}

function fromWorktreeOverride(worktree: Partial<WorktreeConfig>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (worktree.copy !== undefined) raw.copy = worktree.copy;
  if (worktree.link !== undefined) raw.link = worktree.link;
  if (worktree.setup !== undefined) raw.setup = worktree.setup;
  return raw;
}

function toRoleConfig(raw: RawRole): RoleConfig {
  const role: RoleConfig = {
    name: raw.name,
    purpose: raw.purpose,
    agents: raw.agents,
    mode: raw.mode,
    isolation: raw.isolation,
    network: raw.network,
    timeout_ms: raw.timeout,
  };
  if (raw.system_prompt_file !== undefined) role.system_prompt_file = raw.system_prompt_file;
  return role;
}

function toAgentSpec(raw: RawAgent): GenericAgentSpec {
  const spec: GenericAgentSpec = { id: raw.id, bin: raw.bin, args: raw.args };
  if (raw.display_name !== undefined) spec.displayName = raw.display_name;
  if (raw.cwd_mode !== undefined) spec.cwdMode = raw.cwd_mode;
  if (raw.native_read_only !== undefined) spec.capabilities = { nativeReadOnly: raw.native_read_only };
  if (raw.network_args !== undefined) spec.networkArgs = raw.network_args;
  return spec;
}

/**
 * Inverse of `toPolicyOverride`: returns only the fields actually
 * present in `policy`. `PolicyConfig` (complete) can be passed to
 * this function just as well as `Partial<PolicyConfig>` — a complete object
 * has, by definition, all its fields "present" — which lets it serve both
 * to serialize a partial layer (`saveLayer`, the materialization
 * of a list) and a complete configuration (`caesar init --global`, which
 * writes `defaultConfig()` in full to the global layer).
 */
function fromPolicyOverride(policy: Partial<PolicyConfig>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (policy.allowed !== undefined) raw.allowed = policy.allowed;
  if (policy.denied !== undefined) raw.denied = policy.denied;
  if (policy.max_parallel !== undefined) raw.max_parallel = policy.max_parallel;
  if (policy.default_isolation !== undefined) raw.default_isolation = policy.default_isolation;
  if (policy.default_mode !== undefined) raw.default_mode = policy.default_mode;
  if (policy.default_network !== undefined) raw.default_network = policy.default_network;
  // Stored as raw milliseconds rather than reformatted as "10m": one
  // form, `parseDuration` accepts it just as well, and the save/load
  // round-trip thus stays exact instead of depending on inverse formatting.
  if (policy.default_timeout_ms !== undefined) raw.default_timeout = policy.default_timeout_ms;
  if (policy.allow_recursion !== undefined) raw.allow_recursion = policy.allow_recursion;
  if (policy.allow_inplace_write !== undefined) raw.allow_inplace_write = policy.allow_inplace_write;
  if (policy.max_depth !== undefined) raw.max_depth = policy.max_depth;
  return raw;
}

function fromRoleConfig(role: RoleConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: role.name,
    purpose: role.purpose,
    agents: role.agents,
    mode: role.mode,
    isolation: role.isolation,
    network: role.network,
    timeout: role.timeout_ms,
  };
  if (role.system_prompt_file !== undefined) out.system_prompt_file = role.system_prompt_file;
  return out;
}

function fromAgentSpec(agent: GenericAgentSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { id: agent.id, bin: agent.bin, args: agent.args };
  if (agent.displayName !== undefined) out.display_name = agent.displayName;
  if (agent.cwdMode !== undefined) out.cwd_mode = agent.cwdMode;
  // The only capability the TOML can carry (see `RawAgentSchema`): the
  // others, if a caller slipped some into the `GenericAgentSpec` it
  // registers, would not survive the round-trip. No interface produces
  // any, and `RawAgentSchema` is `.strict()`: they would in any case be
  // refused on re-read.
  if (agent.capabilities?.nativeReadOnly !== undefined) out.native_read_only = agent.capabilities.nativeReadOnly;
  if (agent.networkArgs !== undefined) out.network_args = agent.networkArgs;
  return out;
}

// ---------------------------------------------------------------------------
// Error messages — human-readable, naming the file, the field, and what
// was expected (see the vigilance points of the task 5 brief).
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<string, string> = {
  string: "a string",
  number: "a number",
  int: "an integer",
  boolean: "a boolean",
  array: "a list",
  object: "an object",
};

function describeType(expected: string): string {
  return TYPE_NAMES[expected] ?? expected;
}

function describeReceived(input: unknown): string {
  if (input === undefined) return "no value (field absent)";
  if (input === null) return "null";
  if (Array.isArray(input)) return `a list (${JSON.stringify(input)})`;
  if (typeof input === "string") return `the string ${JSON.stringify(input)}`;
  if (typeof input === "number") return `the number ${input}`;
  if (typeof input === "boolean") return `the boolean ${input}`;
  if (typeof input === "object") return `an object (${JSON.stringify(input)})`;
  return String(input);
}

function describeIssue(issue: ZodIssue): string {
  const field = issue.path.length > 0 ? issue.path.join(".") : "(file root)";
  switch (issue.code) {
    case "unrecognized_keys": {
      const prefix = issue.path.length > 0 ? `${issue.path.join(".")}.` : "";
      const names = issue.keys.map((key) => `"${prefix}${key}"`).join(", ");
      return `${names}: unknown field (check for a typo in the name).`;
    }
    case "invalid_type":
      return `${field}: expected ${describeType(issue.expected)}, received ${describeReceived(issue.input)}`;
    case "invalid_value":
      return `${field}: unrecognized value (expected one of: ${issue.values.map((v) => JSON.stringify(v)).join(", ")})`;
    case "too_small":
      if (issue.origin === "string" && issue.minimum === 1) return `${field}: cannot be empty`;
      if (typeof issue.minimum === "number") {
        return `${field}: must be ${issue.inclusive ? "≥" : ">"} ${issue.minimum}`;
      }
      return `${field}: ${issue.message}`;
    case "custom":
      return `${field}: ${issue.message}`;
    default:
      return `${field}: ${issue.message}`;
  }
}

function formatZodError(error: z.ZodError, filePath: string): string {
  const lines = error.issues.map((issue) => `  - ${describeIssue(issue)}`);
  return `Invalid configuration in ${filePath}:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * The user's home directory — **the only access point to the home
 * directory this monorepo must use** (`mcp-registration.ts`
 * depends on it too, for the MCP config paths under `$HOME` of `copilot`/
 * `antigravity`/`opencode`; any similar future need must go through here,
 * never through a new direct call to `os.homedir()`).
 *
 * `os.homedir()` (Node) already prefers `$HOME` on POSIX, but **Bun** — the
 * runtime of `packages/tui`, see the project's global constraints —
 * silently ignores `$HOME` and always falls back to the real system
 * user, observed while writing the task 15 tests: neutralizing
 * `HOME` to isolate a test (the pattern already in place in
 * `packages/core/src/config.test.ts` and `packages/cli/test/support.ts`)
 * did not stop `globalConfigPath()` from resolving the real
 * `~/.config/caesar/` under Bun, with the real risk of writing into it — which
 * happened while writing the test that revealed the defect. Reading `$HOME`
 * explicitly before falling back to `homedir()` reproduces the existing Node
 * behavior (no change under Node, where `$HOME` already won) and
 * makes it reliable under Bun as well.
 *
 * This fix had at first only routed `globalConfigPath()`: three direct
 * calls to `homedir()` in `mcp-registration.ts` (`buildPlan`, the
 * `copilot`/`antigravity`/`opencode` paths) remained unprotected until the
 * task 15 review, which flagged it — `IntegrationsScreen.render.test.tsx`
 * neutralizes `HOME` then calls `checkMcpStatus` for the five clients on
 * mount, and so read the machine's real files under Bun despite the
 * neutralization. `homeDirectory` exported rather than the rule copied
 * verbatim into that second file.
 */
export function homeDirectory(): string {
  return process.env["HOME"] || homedir();
}

export function globalConfigPath(): string {
  return join(homeDirectory(), ".config", "caesar", "config.toml");
}

export function projectConfigPath(root: string): string {
  return join(root, ".caesar", "config.toml");
}

/** Local layer: never versioned (see `caesar init`, which declares it in the `.gitignore`), specific to one workstation for a given project. */
export function localConfigPath(root: string): string {
  return join(root, ".caesar", "config.local.toml");
}

/** Path of a given layer's file — the only function that may choose between `globalConfigPath`/`projectConfigPath`/`localConfigPath`, so that the choice of layer remains a simple parameter everywhere else (`loadLayer`, `saveLayer`, the CLI facades). */
export function configPathFor(scope: ConfigScope, root: string): string {
  switch (scope) {
    case "global":
      return globalConfigPath();
    case "project":
      return projectConfigPath(root);
    case "local":
      return localConfigPath(root);
  }
}

/** True if `error` is an `ENOENT` (absent file or directory) — shared with `roles.ts`, which has the same need for `system_prompt_file`. */
export function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Reads a configuration file. `null` if absent — that is not an error. Any other error names the file. */
async function readConfigFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Parses and validates the TOML content of a configuration file into a contribution to merge. */
function parseConfigFile(toml: string, filePath: string): ConfigOverride {
  let raw: unknown;
  try {
    raw = parseToml(toml);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new Error(`Invalid TOML file: ${filePath} (line ${error.line}, column ${error.column}) — ${error.message}`);
    }
    throw error;
  }

  const result = RawFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(formatZodError(result.error, filePath));
  }

  // `RawFileSchema` defaults `role`/`agent` to `[]` (`z.array(...).default([])`)
  // so that the schema stays simple to write — but that would make `override`
  // unfaithful to the file: a file that declares no `[[role]]` must
  // produce an absent `override.roles` (`undefined`), not `[]` — that is
  // what `loadLayer` promises ("exactly what the file declares, nothing
  // more"). Hence the check on `raw` itself (before the schema's
  // defaults are applied), the only source that still distinguishes "absent
  // from the file" from "present but empty" (impossible to write for a TOML
  // array of tables, but we do not presume the shape of `raw` beforehand).
  const rawRecord = raw as Record<string, unknown>;
  const override: ConfigOverride = {};
  if (rawRecord["role"] !== undefined) override.roles = result.data.role.map(toRoleConfig);
  if (rawRecord["agent"] !== undefined) override.agents = result.data.agent.map(toAgentSpec);
  if (result.data.worktree) override.worktree = toWorktreeOverride(result.data.worktree);
  if (result.data.policy) {
    // `toPolicyOverride` already returns a `Partial<PolicyConfig>` carrying
    // only the fields present in this file — exactly the shape that
    // `ConfigOverride.policy` expects, without conversion or cast.
    override.policy = toPolicyOverride(result.data.policy);
  }
  return override;
}

const CONFIG_SCOPES: readonly ConfigScope[] = ["global", "project", "local"];

/** Reads and parses a layer, without knowing whether the file existed — shared by `loadLayer` (which only needs the override) and `loadConfig` (which also needs to know whether the layer has a source). */
async function readLayer(scope: ConfigScope, root: string): Promise<{ path: string; text: string | null; override: ConfigOverride }> {
  const path = configPathFor(scope, root);
  const text = await readConfigFile(path);
  const override = text !== null ? parseConfigFile(text, path) : {};
  return { path, text, override };
}

/**
 * Returns exactly what layer `scope` declares — not the result of a
 * merge with the other layers, never default values. An absent file
 * yields an empty override (`{}`), not an error: that is what allows
 * a facade to edit a layer without worrying about its prior
 * existence (see `saveLayer`, and the task 13 brief).
 */
export async function loadLayer(scope: ConfigScope, root: string): Promise<ConfigOverride> {
  return (await readLayer(scope, root)).override;
}

/**
 * Loads the configuration: `defaultConfig()` merged with the global, then
 * the project, then the local layer, in that order — each if it exists. A
 * file absent on all three sides is not an error — the default configuration
 * suffices. `config` is the merge, the only thing consumers read (engine,
 * MCP server, roles, policy); `layers` gives access to each layer's own
 * contribution, for the facades that must know *where* a value lives
 * rather than only *which one* (provenance, targeted writing).
 */
export async function loadConfig(root: string): Promise<LoadedConfig> {
  const sources: { global?: string; project?: string; local?: string } = {};
  const layers: ConfigLayer[] = [];
  let config = defaultConfig();

  for (const scope of CONFIG_SCOPES) {
    const { path, text, override } = await readLayer(scope, root);
    layers.push({ scope, path, override });
    if (text !== null) {
      sources[scope] = path;
      config = mergeConfig(config, override);
    }
  }

  return { config, layers, sources, warnings: [] };
}

export type ProvenanceSource = ConfigScope | "default";

/** The last (most specific) layer for which `predicate(override)` is true, "default" if none. `layers` must be in application order (`loadConfig` guarantees it). */
function lastLayerDeclaring(layers: readonly ConfigLayer[], predicate: (override: ConfigOverride) => boolean): ProvenanceSource {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    if (predicate(layer.override)) return layer.scope;
  }
  return "default";
}

/**
 * Provenance of a `policy` field: the most specific layer that declares
 * it explicitly, "default" if none does. Computed directly from
 * `layers` — replaces the three-load workaround
 * (`computeProvenance`, `packages/cli/src/commands/policy.ts`) that this
 * module gave no way to avoid before layers were introduced.
 */
export function policyFieldProvenance(layers: readonly ConfigLayer[], field: keyof PolicyConfig): ProvenanceSource {
  return lastLayerDeclaring(layers, (override) => override.policy?.[field] !== undefined);
}

/** Provenance of a role by name: the most specific layer that declares a `[[role]]` entry of that name. */
export function roleProvenance(layers: readonly ConfigLayer[], name: string): ProvenanceSource {
  return lastLayerDeclaring(layers, (override) => override.roles?.some((role) => role.name === name) ?? false);
}

/** Provenance of a generic agent by identifier: the most specific layer that declares an `[[agent]]` entry with that id. The native catalog agents (codex, antigravity…) are declared by no layer: always "default". */
export function agentProvenance(layers: readonly ConfigLayer[], id: string): ProvenanceSource {
  return lastLayerDeclaring(layers, (override) => override.agents?.some((agent) => agent.id === id) ?? false);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Merges by key: an `override` entry entirely replaces the `base` entry bearing the same key; the other `base` entries are kept. */
function mergeByKey<T>(base: readonly T[], override: readonly T[] | undefined, keyOf: (item: T) => string): T[] {
  if (!override || override.length === 0) return [...base];
  const merged = new Map(base.map((item) => [keyOf(item), item] as const));
  for (const item of override) {
    merged.set(keyOf(item), item);
  }
  return [...merged.values()];
}

/**
 * `policy` merges field by field (the `override` field, if
 * present, replaces the `base` one). `roles` and `agents` merge by
 * key (`name`, `id`): an `override` entry entirely replaces the same-key
 * `base` entry, entries specific to each level are kept.
 */
export function mergeConfig(base: CaesarConfig, override: ConfigOverride): CaesarConfig {
  const policy: PolicyConfig = override.policy ? { ...base.policy, ...override.policy } : base.policy;
  // Field by field, like `policy` — and therefore by *replacement* of each
  // list, never by concatenation: a union would make it impossible to locally
  // remove an entry inherited from the global layer. See `ConfigOverride.worktree`.
  const worktree: WorktreeConfig = override.worktree ? { ...base.worktree, ...override.worktree } : base.worktree;
  const roles = mergeByKey(base.roles, override.roles, (role) => role.name);
  const agents = mergeByKey(base.agents, override.agents, (agent) => agent.id);
  return { policy, worktree, roles, agents };
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_POLICY: PolicyConfig = {
  allowed: [],
  denied: [],
  max_parallel: 4,
  default_isolation: "auto",
  default_mode: "write",
  // "auto": the network opens wherever the selected agent allows it, and the
  // report says so wherever it does not. "on" as a default would fail
  // every read-only task on codex — hence the `reviewer` and
  // `investigator` roles shipped below.
  default_network: "auto",
  default_timeout_ms: parseDuration("10m"),
  allow_recursion: false,
  // False: a write task does not run in the user's working tree
  // as long as a worktree is possible. The opposite default is what
  // let three delegations write onto a real working branch,
  // silently.
  allow_inplace_write: false,
  max_depth: 2,
};

/**
 * `system_prompt_file` already points here to the `roles/<name>.md` convention
 * (resolved by `resolveRole`, relative to `<root>/.caesar/`), even though
 * no layer has declared it: this is deliberate, since task 13.
 *
 * `caesar init` (project variant) materializes the *file* (`.caesar/roles/<name>.md`,
 * a default system prompt) but no longer declares the role itself in the
 * project layer — otherwise that layer would freeze the default policy and
 * roles at init time, masking any later global configuration
 * (exactly the I11 defect this task fixes). By carrying
 * the file reference here, in the base common to all layers, the
 * role stays usable (empty prompt, `resolveRole` tolerates an absent
 * file) even without `caesar init`, and fills up as soon as `caesar init` has
 * written the file — whatever the project, without the project layer having
 * to repeat it.
 */
const DEFAULT_ROLES: RoleConfig[] = [
  {
    name: "reviewer",
    purpose: "Reviews a diff and reports bugs and regressions. Modifies nothing.",
    agents: ["codex", "antigravity"],
    mode: "read-only",
    isolation: "inplace",
    network: "auto",
    timeout_ms: parseDuration("10m"),
    system_prompt_file: "roles/reviewer.md",
  },
  {
    name: "implementer",
    purpose: "Implements a precise task and returns a reviewed diff.",
    agents: ["codex", "antigravity", "opencode"],
    mode: "write",
    isolation: "worktree",
    network: "auto",
    timeout_ms: parseDuration("10m"),
    system_prompt_file: "roles/implementer.md",
  },
  {
    name: "investigator",
    purpose: "Explores the code and explains a mechanism. Modifies nothing.",
    agents: ["antigravity", "codex", "opencode"],
    mode: "read-only",
    isolation: "auto",
    network: "auto",
    timeout_ms: parseDuration("10m"),
    system_prompt_file: "roles/investigator.md",
  },
];

/** The base configuration, before any merge with a global or project file. Always a fresh copy. */
export function defaultConfig(): CaesarConfig {
  return {
    policy: { ...DEFAULT_POLICY, allowed: [...DEFAULT_POLICY.allowed], denied: [...DEFAULT_POLICY.denied] },
    worktree: { copy: [], link: [], setup: [] },
    roles: DEFAULT_ROLES.map((role) => ({ ...role, agents: [...role.agents] })),
    agents: [],
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const SAVE_HEADER =
  "# File generated by @caesar/core: comments added by hand do not survive the next write.\n\n";

/**
 * Regenerates the file of layer `scope`, from `override` — not
 * from a merged `CaesarConfig`. `override` serializes only what it carries
 * explicitly: a `[policy]` section only for the fields present
 * in `override.policy`, `[[role]]`/`[[agent]]` sections only if
 * `override.roles`/`override.agents` are defined. This is what keeps a
 * layer faithful to what it declares in its own right, never a flattening of
 * the merge (see this module's header, and the I11 defect it fixes):
 * a caller that wants to modify a single field must read the layer
 * beforehand (`loadLayer`) and rewrite only the intended field in the
 * re-read override, on pain of erasing the rest of what it declared.
 *
 * Atomic write (`writeFileAtomic`, `fs-atomic.ts`) — same pattern as
 * `packages/core/src/store.ts`.
 */
export async function saveLayer(scope: ConfigScope, root: string, override: ConfigOverride): Promise<void> {
  const raw: Record<string, unknown> = {};
  if (override.policy !== undefined) raw.policy = fromPolicyOverride(override.policy);
  if (override.worktree !== undefined) raw.worktree = fromWorktreeOverride(override.worktree);
  if (override.roles !== undefined) raw.role = override.roles.map(fromRoleConfig);
  if (override.agents !== undefined) raw.agent = override.agents.map(fromAgentSpec);
  const content = SAVE_HEADER + stringifyToml(raw);

  await writeFileAtomic(configPathFor(scope, root), content);
}

export interface PolicyListEdit {
  /** Effective (merged) list after the edit — what layer `scope` now carries. */
  effective: string[];
  /** True if layer `scope` did not yet declare this field before this write. */
  materialized: boolean;
}

/**
 * Pure computation of a list materialization — adds or removes `id` from the
 * **effective** list (`effective`, the one `loadConfig` would compute for
 * this field), and reports whether `currentOverride` (what the targeted layer
 * declares today; `undefined` if it does not declare this field yet) is
 * about to be taken over by this write.
 *
 * Separated from `materializePolicyList` (which reads/writes the disk) so
 * that a facade holding its own working copy in memory — the TUI
 * (`packages/tui/src/state/config-state.ts`), which cannot re-read/rewrite
 * the disk on every keystroke without violating "no write without an
 * explicit user action" — applies exactly the same rule rather than
 * copying it (see the task 15 brief, and the two rule duplications
 * between facades this project has already seen).
 */
export function materializeListEdit(
  effective: readonly string[],
  currentOverride: readonly string[] | undefined,
  id: string,
  present: boolean,
): PolicyListEdit {
  const materialized = currentOverride === undefined;
  const set = new Set(effective);
  if (present) set.add(id);
  else set.delete(id);
  return { effective: [...set], materialized };
}

/**
 * Adds or removes `id` from `policy.allowed`/`policy.denied`, at layer
 * `scope` — the list materialization described by the task 13 brief.
 *
 * `allowed`/`denied` merge by whole replacement, not by union
 * (see `mergeConfig`): a layer that declares `denied` replaces that of the
 * less specific layers. Merely writing `[id]` to the targeted layer
 * would therefore erase everything those layers had put there. This function
 * loads the effective list and the targeted layer's current declaration,
 * delegates the computation to `materializeListEdit`, then writes its result
 * — never `id` alone — into the targeted layer, keeping the rest of what it
 * already declared (`loadLayer` re-read before writing).
 *
 * `materialized` is true when the layer did not yet declare this field:
 * it now takes over the entire list, and a less specific layer
 * modified afterwards will have no further effect on this field here. A
 * signal the caller (CLI, TUI) must make visible, not merely
 * log.
 */
export async function materializePolicyList(
  root: string,
  scope: ConfigScope,
  field: "allowed" | "denied",
  id: string,
  present: boolean,
): Promise<PolicyListEdit> {
  const { config: merged } = await loadConfig(root);
  const layer = await loadLayer(scope, root);
  const { effective, materialized } = materializeListEdit(merged.policy[field], layer.policy?.[field], id, present);
  await saveLayer(scope, root, { ...layer, policy: { ...layer.policy, [field]: effective } });
  return { effective, materialized };
}
