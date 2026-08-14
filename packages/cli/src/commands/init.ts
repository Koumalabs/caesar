/**
 * `caesar init [--global]`: creates the project layer (default) or the
 * global layer (`--global`). Never overwrites an existing configuration
 * without `--force`.
 *
 * The **project** layer declares nothing: `defaultConfig()` already carries
 * the default policy and roles (`system_prompt_file` included, a naming
 * convention resolved by `resolveRole` independently of any layer — see
 * `config.ts`) — writing those values into `.caesar/config.toml` would
 * freeze them there, masking any later global configuration (defect I11 of
 * the final review). This command's role, on the project side, is thus
 * limited to materializing the system prompt *files*
 * (`.caesar/roles/<name>.md`) and completing the `.gitignore`.
 *
 * The **global** layer (`--global`), conversely, writes `defaultConfig()`
 * in full: it is the editable starting point of a "preset" shared by all
 * the projects of a machine — see the task 13 plan.
 *
 * ## Agentic knowledge (skill + commands) and refresh
 *
 * `caesar init` also deposits the Agent Skills skill and the commands of
 * the detected runtimes (`installAgentAssets`, `@caesar/core`) — the way a
 * main agent (claude, codex, copilot, opencode, antigravity) learns to
 * direct `caesar` rather than executing itself.
 *
 * **On an already initialized project, without `--force`: refresh.**
 * Rerunning `caesar init` rewrites neither `.caesar/config.toml` nor
 * `.caesar/roles/*.md` — those are the files the user edits (policy, roles,
 * system prompts), and an `init` rerun by reflex (or by a script) would
 * overwrite them unintentionally. Only the agentic assets are
 * rewritten/refreshed: they are, for their part, entirely derived from the
 * catalog (`AGENT_ASSETS`) and thus nothing like content the user owns —
 * rewriting them identical to the catalog never erases a choice they would
 * have made. This is what replaces the old `EXIT_USAGE` guard
 * ("configuration already present"): the command always succeeds (code 0),
 * and says so.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_ASSETS,
  MCP_CLIENTS,
  configPathFor,
  defaultConfig,
  detectUntrackedNeeds,
  findBinaryInPath,
  installAgentAssets,
  isEnoent,
  isMcpClient,
  listAgentDefinitions,
  loadConfig,
  projectConfigPath,
  repoRoot,
  saveLayer,
  writeFileAtomic,
} from "@caesar/core";
import type { AgentAssetInstall, AssetScope, McpClient, WorktreeConfig } from "@caesar/core";
import type { Io } from "../output.js";
import { VERSION } from "../version.js";
import {
  EXIT_OK,
  EXIT_USAGE,
  activeGlyphs,
  bannerLines,
  colorize,
  homePath,
  printDone,
  printError,
  printJson,
  printNote,
  printWarning,
  writeLine,
} from "../output.js";

export interface InitOptions {
  force?: boolean;
  json?: boolean;
  global?: boolean;
  /** `--agent <id>`, repeatable: forces the target list rather than PATH detection. Already validated (against `MCP_CLIENTS`) by `runInit` before any use. */
  agent?: readonly string[];
  /** `--no-skills` (commander): `false` fully disables depositing/refreshing the agentic assets. Not persisted — pass it again on each `init`. */
  skills?: boolean;
}

/**
 * Default system prompts, one per role shipped by `defaultConfig()`. In
 * English: this is text injected into the model (see the project's global
 * constraints), not a CLI message.
 */
const DEFAULT_ROLE_PROMPTS: Record<string, string> = {
  reviewer:
    "You are acting as a code reviewer. Review the diff you are given for bugs, regressions and risks. Do not modify any file; report what you find instead.",
  implementer:
    "You are acting as an implementer. Implement the requested task precisely, and leave behind a clear, reviewable diff.",
  investigator:
    "You are acting as an investigator. Explore the codebase to explain the mechanism you are asked about. Do not modify any file.",
};

function defaultRolePrompt(name: string): string {
  return DEFAULT_ROLE_PROMPTS[name] ?? `You are acting in the "${name}" role.`;
}

/**
 * Paths the orchestrator must never version: the local layer (specific to
 * each machine) and the execution directories (tasks, worktrees, state) —
 * see finding I5 of the final review, taken up here since this command is
 * rewritten by task 13 anyway.
 */
const GITIGNORE_ENTRIES = [".caesar/config.local.toml", ".caesar/tasks/", ".caesar/wt/", ".caesar/state/"];

interface GitignoreResult {
  path: string;
  added: string[];
}

/**
 * Completes `<root>/.gitignore` with `GITIGNORE_ENTRIES`. Only adds the
 * missing lines, never rewrites an existing file from scratch — a
 * hand-edited `.gitignore` keeps its content. `isGitRepo` is computed by
 * the caller (`repoRoot`, a git subprocess) and reused here rather than
 * relaunched: `runInitProject` needs it anyway for its own warning, no
 * point paying for the subprocess twice. `null` if `root` is not a git
 * repository: nothing is written, the caller flags it in its own output
 * rather than this function writing an orphan `.gitignore` outside any
 * repository.
 *
 * Atomic write (`writeFileAtomic`, `@caesar/core`) — same motive as
 * `saveLayer` (`config.ts`) and `packages/core/src/store.ts`, rather than
 * rewriting `.gitignore` in place.
 */
async function completeGitignore(root: string, isGitRepo: boolean): Promise<GitignoreResult | null> {
  if (!isGitRepo) return null;

  const path = join(root, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  const existingLines = new Set(existing.split("\n").map((line) => line.trim()));
  const added = GITIGNORE_ENTRIES.filter((entry) => !existingLines.has(entry));
  if (added.length === 0) return { path, added };

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? existing + "\n" : existing;
  const content = prefix + added.join("\n") + "\n";
  await writeFileAtomic(path, content);
  return { path, added };
}

// ---------------------------------------------------------------------------
// Agentic knowledge — target selection, deposit, rendering
// ---------------------------------------------------------------------------

/**
 * Internal target, never announced in `targets`: it only serves to deposit
 * the shared base (`.agents/skills/caesar/`, see `ASSET_TARGETS` in
 * `agent-assets.ts`) when no runtime was detected and no `--agent` was
 * given. `codex` carries neither commands nor a `settings.json` merge —
 * choosing it therefore never deposits anything beyond the shared base
 * itself. The bet: non-`claude` runtimes all read this same directory, so
 * depositing it in advance benefits the first of them that gets
 * installed — without pretending a specific runtime is already served.
 */
const SHARED_ONLY_CLIENT: McpClient = "codex";

/**
 * Detects, for each client of `MCP_CLIENTS`, whether its binary is present
 * in the PATH — never `detectAgentInstallation` (which probes `--version`,
 * up to 3 s per agent: costly and beside the point here, we only want to
 * know "present or not"), and never the configuration's generic agents
 * (`[[agent]]`): `caesar init` deposits the knowledge of the five native
 * runtimes, not of a custom agent that will not read any standard skill
 * anyway.
 */
async function detectMcpClients(): Promise<McpClient[]> {
  const defs = listAgentDefinitions();
  const present: McpClient[] = [];
  for (const client of MCP_CLIENTS) {
    const def = defs.find((d) => d.id === client);
    if (def && (await findBinaryInPath(def.bin))) present.push(client);
  }
  return present;
}

interface TargetSelection {
  /** Targets announced to the user — empty only in the "zero detected, no --agent" case. */
  targets: readonly McpClient[];
  /** Targets actually passed to `installAgentAssets` — never empty (see `SHARED_ONLY_CLIENT`). */
  install: readonly McpClient[];
}

/** `agent` is already validated by `runInit` (each id is a known `McpClient`) before reaching this function. */
async function selectAssetTargets(agent: readonly string[] | undefined): Promise<TargetSelection> {
  if (agent && agent.length > 0) {
    const explicit = [...new Set(agent)].filter(isMcpClient);
    return { targets: explicit, install: explicit };
  }
  const detected = await detectMcpClients();
  if (detected.length > 0) return { targets: detected, install: detected };
  return { targets: [], install: [SHARED_ONLY_CLIENT] };
}

interface AssetOutcome {
  targets: readonly McpClient[];
  install: AgentAssetInstall;
}

/**
 * Computes the targets then deposits/refreshes the skill and the commands.
 * Called on the first `init` as on a refresh — it is the only part of the
 * command that runs in both cases (see the module header): the runtimes
 * present today are not necessarily those detected at the first `init`, and
 * nothing prevents adding `--agent` between two passes.
 */
async function depositAssets(root: string, scope: AssetScope, options: InitOptions): Promise<AssetOutcome> {
  const selection = await selectAssetTargets(options.agent);
  const install = await installAgentAssets({ root, scope, clients: selection.install, catalog: AGENT_ASSETS });
  return { targets: selection.targets, install };
}

function plural(n: number): string {
  return n > 1 ? "s" : "";
}

/**
 * Renders the result of `depositAssets` as human output: a confirmation
 * line naming the served runtimes and the number of files
 * deposited/refreshed, an aggregated warning for the files that diverged
 * from the catalog and got replaced, then the logical next step: the skill
 * calls the tools of the `caesar` MCP server, which only exist for a
 * runtime once `caesar mcp install <client>` has been run for it.
 *
 * Does NOT render `outcome.install.warnings` (a malformed `settings.json`,
 * notably): those are the only warnings of the module that must also appear
 * in `--json`, so the caller routes them through the existing top-level
 * `warnings` array rather than through this function — a single rendering
 * path, never a human-output duplicate between this function and the loop
 * that drains that array.
 */
function printAssetsOutcome(io: Io, outcome: AssetOutcome): void {
  const changed = outcome.install.files.filter((f) => f.action !== "unchanged");
  const total = outcome.install.files.length;
  const label =
    outcome.targets.length > 0
      ? `Agentic knowledge deposited for ${outcome.targets.join(", ")}`
      : "No runtime detected in the PATH: shared base (.agents/skills/caesar/) deposited anyway";
  printDone(
    io,
    `${label} — ${changed.length} file${plural(changed.length)} deposited or refreshed (out of ${total} managed).`,
  );

  const updated = outcome.install.files.filter((f) => f.action === "update");
  if (updated.length > 0) {
    printWarning(
      io,
      `${updated.length} caesar-managed file${plural(updated.length)} replaced, diverging from the catalog: ${updated.map((f) => homePath(f.path)).join(", ")}`,
    );
  }

  printNote(
    io,
    'The skill calls the tools of the "caesar" MCP server: they only exist for a runtime once "caesar mcp install <client>" has been run for it.',
  );
}

// ---------------------------------------------------------------------------
// init --global / init (project)
// ---------------------------------------------------------------------------

async function runInitGlobal(root: string, options: InitOptions, io: Io): Promise<number> {
  const loaded = await loadConfig(root);
  // Without --force, an already present global layer is no longer a
  // refusal: the command succeeds, leaves `defaultConfig()` intact (the
  // user may have edited that "preset"), and merely refreshes the assets —
  // same refresh contract as on the project side, see the module header.
  const refresh = loaded.sources.global !== undefined && !options.force;
  if (!refresh) {
    await saveLayer("global", root, defaultConfig());
  }

  const assets = options.skills === false ? null : await depositAssets(root, "global", options);

  const configPath = configPathFor("global", root);
  if (options.json) {
    printJson(io, {
      scope: "global",
      config_path: configPath,
      // `true` on a refresh (see the module header): without this marker, a
      // JSON consumer cannot distinguish "nothing to rewrite this time"
      // from "this field never had anything to say" (finding I3 of the
      // final review) — the ambiguity pushes toward `--force`, the only
      // destructive path.
      refreshed: refresh,
      assets: assets ? { targets: assets.targets, files: assets.install.files, stale: assets.install.stale } : null,
    });
  } else {
    printDone(
      io,
      refresh
        ? `Global configuration left untouched: ${homePath(configPath)} (--force to reset it).`
        : `Global configuration created: ${homePath(configPath)}`,
    );
    if (assets) {
      printAssetsOutcome(io, assets);
      // `computeSettingsMerge` (agent-assets.ts) can emit nothing in global
      // scope (it bails out early on `scope !== "project"`): this array is
      // therefore always empty today, but rendered anyway, so as not to
      // silently depend on that invariant if the module one day learned
      // another global-scope warning.
      for (const warning of assets.install.warnings) printWarning(io, warning);
    }
  }
  return EXIT_OK;
}

async function runInitProject(root: string, options: InitOptions, io: Io): Promise<number> {
  const loaded = await loadConfig(root);
  // Without --force, an already initialized project is no longer a refusal:
  // it is a refresh (see the module header) — `.caesar/config.toml` and
  // `.caesar/roles/*.md` remain strictly intact, only the agentic assets
  // are rewritten/refreshed.
  const refresh = loaded.sources.project !== undefined && !options.force;

  const rolesDir = join(root, ".caesar", "roles");
  const roleFiles: string[] = [];
  let worktree: WorktreeConfig | null = null;

  if (!refresh) {
    await mkdir(rolesDir, { recursive: true });

    // The default roles already carry their `system_prompt_file` (see
    // `defaultConfig()`): all that remains is materializing the file
    // itself, not declaring the role in the project layer — see this
    // module's header.
    for (const role of defaultConfig().roles) {
      if (!role.system_prompt_file) continue;
      const absPath = join(root, ".caesar", role.system_prompt_file);
      await writeFile(absPath, defaultRolePrompt(role.name) + "\n", "utf8");
      roleFiles.push(absPath);
    }

    // The project layer declares nothing more than itself at
    // initialization: writing the default policy and roles here would redo
    // exactly the defect I11 this task fixes (the layer would freeze the
    // default values, masking any global configuration). This empty file
    // simply marks the project's initialization.
    //
    // `[worktree]` is the exception, and for a precise reason: it is not a
    // default value but a **fact about this very project** — what its
    // worktree must carry so that one can work in it. Without this section,
    // a worktree contains only the tracked files, isolation becomes
    // unusable, and bypassing it via `isolation = "inplace"` remains the
    // only practicable way out: the original defect. Nothing is written
    // when nothing is detected — an empty section would look like a setting.
    worktree = await detectUntrackedNeeds(root);
    await saveLayer("project", root, worktree ? { worktree } : {});
  }

  const warnings: string[] = [];
  const isGitRepo = (await repoRoot(root)) !== null;
  if (!isGitRepo) {
    warnings.push(
      `"${root}" is not a git repository: "worktree" isolation is not available here, the orchestrator will fall back to "inplace" for write tasks, and the ".gitignore" was not completed. Run "git init" in this directory to enable both.`,
    );
  }
  const gitignore = await completeGitignore(root, isGitRepo);

  const assets = options.skills === false ? null : await depositAssets(root, "project", options);
  if (assets) {
    // The module's warnings (a malformed or oddly shaped `settings.json`,
    // notably — see `computeSettingsMerge`, agent-assets.ts) join the same
    // array as the warnings above rather than living only in the human
    // output: without that, a `--json` consumer would see `assets.files`
    // full of successes without ever learning that a permissions merge was
    // skipped (`action: "skip"`).
    warnings.push(...assets.install.warnings);
  }
  if (!isGitRepo && assets) {
    warnings.push(
      `Outside a git repository, the deposited agentic knowledge files (skill, commands) will not be versioned: run "git init" in this directory to share them with the team.`,
    );
  }

  const configPath = projectConfigPath(root);
  if (options.json) {
    printJson(io, {
      root,
      config_path: configPath,
      roles_dir: rolesDir,
      role_files: roleFiles,
      gitignore: gitignore ? { path: gitignore.path, added: gitignore.added } : null,
      worktree,
      // `true` on a refresh (see the module header): on a refresh,
      // `role_files` is `[]` and `worktree` is `null` without any role or
      // workshop having disappeared — without this marker, a JSON consumer
      // cannot distinguish "nothing to rewrite this time" from "this
      // project has neither roles nor [worktree]" (finding I3 of the final
      // review), and the plausible reaction to that latter reading is
      // `--force`, the only destructive path.
      refreshed: refresh,
      warnings,
      assets: assets ? { targets: assets.targets, files: assets.install.files, stale: assets.install.stale } : null,
    });
  } else {
    // The wordmark opens `caesar init` and nothing else: it is the only
    // command one types once, without yet knowing what the tool is.
    // Anywhere else it would be noise on every invocation.
    for (const line of bannerLines(io.stdout, `sub-agent orchestrator · v${VERSION}`)) writeLine(io.stdout, line);
    writeLine(io.stdout);
    if (refresh) {
      printDone(io, `Configuration and system prompts left untouched: ${homePath(configPath)} (--force to reset them).`);
    } else {
      printDone(io, `Configuration created: ${homePath(configPath)}`);
      printDone(io, `Default system prompts: ${homePath(rolesDir)}`);
    }
    if (gitignore) {
      writeLine(
        io.stdout,
        `${colorize(activeGlyphs().status.done, "ok", io.stdout)} ` +
          (gitignore.added.length > 0
            ? `.gitignore completed: ${homePath(gitignore.path)} (+${gitignore.added.length} line${gitignore.added.length > 1 ? "s" : ""})`
            : `.gitignore already up to date: ${homePath(gitignore.path)}`),
      );
    }
    if (worktree) {
      // Announced rather than deposited in silence: these paths will be
      // copied into each worktree and these commands will run there before
      // each sub-agent. It is an assumption about the project, and it gets
      // fixed in the file.
      const parts = [
        worktree.copy.length > 0 ? `copies ${worktree.copy.join(", ")}` : "",
        worktree.setup.length > 0 ? `runs ${worktree.setup.join(" ; ")}` : "",
      ].filter(Boolean);
      printDone(io, `Sub-agent workshop ([worktree]): ${parts.join(" then ")}`);
    }
    if (assets) printAssetsOutcome(io, assets);
    for (const warning of warnings) printWarning(io, warning);
  }
  return EXIT_OK;
}

export async function runInit(root: string, options: InitOptions, io: Io): Promise<number> {
  // Validated once, before any write and before the project/global choice:
  // an unknown `--agent` is a pure usage error, independent of the
  // project's state or of the targeted scope.
  if (options.agent && options.agent.length > 0) {
    const invalid = options.agent.filter((id) => !isMcpClient(id));
    if (invalid.length > 0) {
      printError(
        io,
        `Unknown agent(s) for --agent: ${invalid.map((id) => `"${id}"`).join(", ")} (expected one of: ${MCP_CLIENTS.join(", ")}).`,
      );
      return EXIT_USAGE;
    }
  }
  return options.global ? runInitGlobal(root, options, io) : runInitProject(root, options, io);
}
