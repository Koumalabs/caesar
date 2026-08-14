/**
 * Commander wiring of the subcommands described by the task 6 brief, around
 * `@caesar/core`: `buildProgram` builds the program, `runCli` wraps it
 * (parses `argv`, translates `CommanderError`s into an exit code). Neither
 * parses `process.argv` nor calls `process.exit` — they are pure functions
 * from the process's point of view, which makes them importable without
 * side effects by a test, or by an entry point.
 *
 * Two entry points import them (task 12):
 *  - `bin.ts`, the Node entry point (`node dist/bin.js`), which wraps them
 *    in a self-invocation guard (`isMain`);
 *  - `bun-entry.ts`, the entry point of the standalone binary compiled by
 *    Bun, which wraps them in a different guard — see below.
 *
 * This module originally lived in `bin.ts` itself, `isMain` included.
 * Separated here during the task 12 review: `bin.ts` imported by
 * `bun-entry.ts` (to reuse `runCli` "the existing commander program" rather
 * than duplicating it) then ran the CLI *twice* in the compiled binary — a
 * double `caesar --version`/`caesar doctor` observed by checking the real
 * binary, never in the `vitest` tests, which never assemble a Bun binary.
 * The cause: in an executable produced by `bun build --compile`,
 * `import.meta.url` is the same virtual URL (`file:///$bunfs/root/<binary
 * name>`) for *all* modules of the bundle, whatever their original source
 * file — and `process.argv[1]` is that same URL. The guard
 * `fileURLToPath(import.meta.url) === process.argv[1]` of `bin.ts`,
 * designed for Node (where each module keeps its own `import.meta.url`),
 * thus became true for any module of the bundle, including `bin.ts`
 * imported as a plain library by `bun-entry.ts`: its self-invocation block
 * fired a second time, on top of `bun-entry.ts`'s explicit call. By moving
 * `buildProgram`/`runCli` out of `bin.ts` into this neutral module,
 * `bun-entry.ts` never imports the file carrying that guard anymore:
 * `bin.ts` remains the only one to self-invoke, and only when Node loads it
 * as the real entry point.
 */
import { Command, CommanderError } from "commander";
import {
  ARG_TOKENS_HINT,
  runAgentsAdd,
  runAgentsDisable,
  runAgentsEnable,
  runAgentsList,
  runAgentsRemove,
  runAgentsSetModel,
  runAgentsTest,
  runAgentsUnsetModel,
} from "./commands/agents.js";
import type { AgentsAddOptions } from "./commands/agents.js";
import { runChannelServe } from "./commands/channel.js";
import { runConfig } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runGc } from "./commands/gc.js";
import { runInit } from "./commands/init.js";
import { runMcpInstall, runMcpServe } from "./commands/mcp.js";
import { runPolicyAllow, runPolicyDeny, runPolicyShow } from "./commands/policy.js";
import { runProtocolSchema } from "./commands/protocol.js";
import { runRoleAdd, runRoleList, runRoleRemove, runRoleShow } from "./commands/role.js";
import { runRun } from "./commands/run.js";
import { runApply, runCancel, runDiff, runLogs, runPs } from "./commands/tasks.js";
import { runWatch } from "./commands/watch.js";
import type { Io } from "./output.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, printError, processIo } from "./output.js";
import { formatHelp } from "./help.js";
import { resolveRoot } from "./root.js";
import { VERSION } from "./version.js";

interface GlobalOptions {
  root?: string;
  json?: boolean;
}

/** True if `error` carries a system `.code` (`fs` error, subprocess…) rather than a hand-written business `Error`. */
function hasSystemErrorCode(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error;
}

/** Options common to every command: `--root` (explicit root) and `--json` (machine output). */
function withCommonOptions(command: Command): Command {
  return command
    .option("--root <dir>", "Project root (default: automatic search from the current directory)")
    .option("--json", "JSON output, without color or formatting");
}

/**
 * `--global`/`--local`: the layer targeted by a command that writes
 * (`policy allow|deny`, `agents enable|disable`, `role add|remove`).
 * Without one or the other: the project layer, as before task 13. Mutually
 * exclusive — `resolveScope` (`../scope.js`) checks it at runtime and says
 * it clearly rather than letting the last one read win silently.
 */
function withScopeOptions(command: Command): Command {
  return command
    .option("--global", "Target the global layer (~/.config/caesar/config.toml) rather than the project layer.")
    .option("--local", "Target the project's local layer (.caesar/config.local.toml, unversioned) rather than the project layer.");
}

/**
 * Builds the commander program. Parses nothing: `exitCodeRef` receives the
 * exit code of the executed command, read by the caller after `parseAsync`.
 *
 * `argv` is only used to know whether a "--" appeared on the command line
 * (see the `run` command). Commander does not keep it in its public API —
 * it does carry a `rawArgs`, but outside the typings, hence outside the
 * contract. Passing it explicitly costs one parameter and depends on
 * nothing internal.
 */
export function buildProgram(io: Io, exitCodeRef: { value: number }, argv: readonly string[] = []): Command {
  const program = new Command();
  program
    .name("caesar")
    .description("Orchestrator of coding sub-agents (Antigravity, Codex, OpenCode, Copilot, Claude).")
    // Commander's default labels get in the way here: without these three
    // replacements, "output the version number" and "display help for
    // command" appeared in the middle of an otherwise curated help.
    .version(VERSION, "-V, --version", "Print the caesar version.")
    .helpOption("-h, --help", "Show this help.")
    .helpCommand("help [command]", "Show the help of a command.")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.stdout.write(str),
      writeErr: (str) => io.stderr.write(str),
    })
    // Set **before** the subcommands are created: commander copies the help
    // configuration at `.command()` time, never afterwards. Configured
    // further down, it would only apply to `caesar --help` and leave
    // `caesar run --help` with the stock rendering.
    .configureHelp({ formatHelp: (cmd, helper) => formatHelp(cmd, helper, io) });

  async function run(action: () => Promise<number>): Promise<void> {
    try {
      exitCodeRef.value = await action();
    } catch (error) {
      // Safety net: each command already returns its own code for its
      // expected failures (policy refusal, invalid argument, unknown
      // task…). An exception rising all the way here is therefore
      // unexpected, and of two possible natures, distinguished here rather
      // than both mapped to code 2 (task 10, C):
      //  - most often, `loadConfig` failing on a malformed configuration
      //    file (invalid TOML, schema not honored) — that remains, by
      //    nature, a configuration/usage error: code 2. These errors are
      //    always hand-written `Error`s, without a `.code` (see
      //    `config.ts`, which systematically rewraps system errors before
      //    rethrowing them).
      //  - a real execution failure (I/O, git subprocess, etc.) on the
      //    contrary carries a system `.code` — that one belongs to code 1.
      printError(io, error instanceof Error ? error.message : String(error));
      exitCodeRef.value = !(error instanceof CommanderError) && hasSystemErrorCode(error) ? EXIT_RUNTIME : EXIT_USAGE;
    }
  }

  // ---------------------------------------------------------------------
  // init / doctor
  // ---------------------------------------------------------------------

  withCommonOptions(program.command("init"))
    .description(
      'Creates <root>/.caesar/config.toml and each role\'s default system prompts, and deposits the agentic knowledge (skill + commands) for the detected runtimes. On an already initialized project, refreshes the assets without touching the configuration or the roles (--force to reset everything). --global: ~/.config/caesar/config.toml, never versioned — the project level, on the other hand, is, hence shared with the team.',
    )
    .option("--force", "Fully reinitializes: rewrites the existing configuration and system prompts (the assets, for their part, are always refreshed anyway).")
    .option("--global", "Creates/refreshes the global layer (~/.config/caesar/config.toml) rather than the project layer — never versioned, specific to this machine.")
    .option(
      "--agent <id>",
      'Forces the deposit for this runtime rather than automatic detection (repeatable): claude, codex, copilot, opencode or antigravity — the runtime that READS the skill (the ordering side), not the executor chosen by "caesar run --agent".',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--no-skills", 'Neither deposits nor refreshes the skill or the agentic commands. Not remembered: pass it again on each "init".')
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions & { force?: boolean; global?: boolean; agent?: string[]; skills?: boolean }>();
      await run(async () => {
        const root = await resolveRoot(opts.root);
        return runInit(root, { force: opts.force, json: opts.json, global: opts.global, agent: opts.agent, skills: opts.skills }, io);
      });
    });

  withCommonOptions(program.command("doctor"))
    .description("Installation diagnosis: presence, version, capabilities and status of each agent of the catalog.")
    .option("--verbose", "Adds the binary path and the capabilities spelled out.")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions & { verbose?: boolean }>();
      await run(async () => {
        const root = await resolveRoot(opts.root);
        return runDoctor(root, { json: opts.json, verbose: opts.verbose }, io);
      });
    });

  withCommonOptions(program.command("config"))
    // The description used to speak of Bun and a "without Bun" fallback:
    // true of the monorepo's Node path only, false of the compiled binary —
    // which embeds Bun and mounts the TUI in its own process (see
    // `commands/config.ts`). It now describes what the command does, not
    // what powers it: the Bun constraint, when it applies, is already
    // explained at the moment it blocks.
    .description("Configures agents, roles, policy and integrations in an interactive screen.")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => {
        // `withCommonOptions` aligns this command with all the others
        // (task 10, C2), which makes it accept `--json` — but this command
        // launches an interactive TUI, with no machine output to produce.
        // Accepting it silently would imply it was honored: refused
        // explicitly rather than ignored (task 10 review).
        if (opts.json) {
          printError(io, '--json makes no sense for "caesar config": this command launches an interactive TUI, not machine output.');
          return EXIT_USAGE;
        }
        return runConfig(await resolveRoot(opts.root), io);
      });
    });

  // ---------------------------------------------------------------------
  // agents
  // ---------------------------------------------------------------------

  const agents = program.command("agents").description("Agent catalog: presence, authorization, capabilities.");

  withCommonOptions(agents.command("list"))
    .description("Lists the agent catalog.")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runAgentsList(await resolveRoot(opts.root), { json: opts.json }, io));
    });

  withScopeOptions(withCommonOptions(agents.command("enable")))
    .description("Removes an agent from the policy's \"denied\" list (project layer by default; --global/--local).")
    .argument("<id>", "Agent identifier")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runAgentsEnable(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  withScopeOptions(withCommonOptions(agents.command("disable")))
    .description("Adds an agent to the policy's \"denied\" list (project layer by default; --global/--local).")
    .argument("<id>", "Agent identifier")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runAgentsDisable(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  withScopeOptions(withCommonOptions(agents.command("add")))
    .description("Declares an agent: a CLI outside the catalog, described by its command and its argument template.")
    .argument("<id>", "Agent identifier, as it will be written in --agent and in the roles")
    .requiredOption("--bin <command>", "Binary to launch (looked up in the PATH, or an absolute path).")
    .option(
      "--args <template>",
      `Argument line, quotes honored. Substituted tokens: ${ARG_TOKENS_HINT}. The first is mandatory — without it, the agent never receives the objective.`,
      "{{prompt}}",
    )
    .option("--display-name <name>", "Readable name shown instead of the identifier.")
    .option(
      "--cwd-mode <mode>",
      '"process" (default): the current directory carries the workspace. "flag": the workspace is already passed as an argument.',
      "process",
    )
    .option(
      "--read-only-native",
      "Declares that this CLI enforces a read-only mode itself: a read-only task will not need to be isolated in a worktree.",
    )
    .action(
      async (
        id: string,
        options: GlobalOptions & AgentsAddOptions,
        command: Command,
      ) => {
        const opts = command.optsWithGlobals<typeof options>();
        await run(async () =>
          runAgentsAdd(
            await resolveRoot(opts.root),
            id,
            {
              bin: opts.bin,
              args: opts.args,
              displayName: opts.displayName,
              cwdMode: opts.cwdMode,
              readOnlyNative: opts.readOnlyNative,
              json: opts.json,
              global: opts.global,
              local: opts.local,
            },
            io,
          ),
        );
      },
    );

  withScopeOptions(withCommonOptions(agents.command("remove")))
    .description("Removes an agent declaration from the targeted layer (project layer by default; --global/--local).")
    .argument("<id>", "Identifier of the declared agent")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runAgentsRemove(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  withScopeOptions(withCommonOptions(agents.command("set-model")))
    .description(
      "Sets the agent's default model ([models] table; project layer by default, --global/--local). Beaten by a role's model, then by an explicit --model.",
    )
    .argument("<id>", "Agent identifier")
    .argument("<model>", "Model name, as the agent's own CLI accepts it")
    .action(
      async (id: string, model: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
        const opts = command.optsWithGlobals<typeof options>();
        await run(async () =>
          runAgentsSetModel(await resolveRoot(opts.root), id, model, { json: opts.json, global: opts.global, local: opts.local }, io),
        );
      },
    );

  withScopeOptions(withCommonOptions(agents.command("unset-model")))
    .description("Removes the agent's default model from the targeted layer (project layer by default; --global/--local).")
    .argument("<id>", "Agent identifier")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runAgentsUnsetModel(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  withCommonOptions(agents.command("test"))
    .description("Launches a read-only micro-task to check that an agent responds. Consumes its real quota.")
    .argument("<id>", "Agent identifier")
    .option("--yes", "Confirms the real execution (mandatory, no interactive confirmation).")
    .action(async (id: string, options: GlobalOptions & { yes?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions & { yes?: boolean }>();
      await run(async () => runAgentsTest(await resolveRoot(opts.root), id, { yes: opts.yes, json: opts.json }, io));
    });

  // ---------------------------------------------------------------------
  // policy
  // ---------------------------------------------------------------------

  const policy = program.command("policy").description("Delegation policy: allow/deny lists, provenance.");

  withCommonOptions(policy.command("show"))
    .description("Shows the effective policy, with the provenance of each value (global, project, default).")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runPolicyShow(await resolveRoot(opts.root), { json: opts.json }, io));
    });

  withScopeOptions(withCommonOptions(policy.command("allow")))
    .description("Adds an agent to the \"allowed\" list (project layer by default; --global/--local).")
    .argument("<id>", "Agent identifier")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runPolicyAllow(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  withScopeOptions(withCommonOptions(policy.command("deny")))
    .description("Adds an agent to the \"denied\" list (project layer by default; --global/--local).")
    .argument("<id>", "Agent identifier")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runPolicyDeny(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  // ---------------------------------------------------------------------
  // role
  // ---------------------------------------------------------------------

  const role = program.command("role").description("Roles: fallback agents, mode, isolation, system prompt.");

  withCommonOptions(role.command("list"))
    .description("Lists the roles, with the agent that would be picked today.")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runRoleList(await resolveRoot(opts.root), { json: opts.json }, io));
    });

  withCommonOptions(role.command("show"))
    .description("Details of a role, system prompt included.")
    .argument("<name>", "Role name")
    .action(async (name: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runRoleShow(await resolveRoot(opts.root), name, { json: opts.json }, io));
    });

  withScopeOptions(withCommonOptions(role.command("remove")))
    .description("Deletes a role (project layer by default; --global/--local — only if that layer declares it).")
    .argument("<name>", "Role name")
    .action(async (name: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runRoleRemove(await resolveRoot(opts.root), name, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  withScopeOptions(withCommonOptions(role.command("add")))
    .description("Creates or replaces a role (project layer by default; --global/--local). Non-interactive — comfortable editing belongs to the TUI.")
    .argument("<name>", "Role name")
    .option("--purpose <text>", "The role's intent, in one sentence.")
    .option("--agents <ids>", "Candidate agents, in fallback order, comma-separated (a,b,c).")
    .option("--mode <mode>", "\"read-only\" or \"write\".")
    .option(
      "--isolation <isolation>",
      "\"worktree\" (dedicated workshop on a disposable branch), \"auto\" (default, picks the worktree for writes) or \"inplace\" — the latter refused for writes in a git repository without allow_inplace_write.",
    )
    .option("--network <network>", "\"auto\" (default), \"on\" (refuses the delegation if the agent cannot open the network) or \"off\".")
    .option("--timeout <duration>", "Maximum delay, e.g. \"10m\" (default: 10m).")
    .action(
      async (
        name: string,
        options: GlobalOptions & {
          purpose?: string;
          agents?: string;
          mode?: string;
          isolation?: string;
          network?: string;
          timeout?: string;
          global?: boolean;
          local?: boolean;
        },
        command: Command,
      ) => {
        const opts = command.optsWithGlobals<typeof options>();
        await run(async () =>
          runRoleAdd(
            await resolveRoot(opts.root),
            name,
            {
              purpose: opts.purpose,
              agents: opts.agents,
              mode: opts.mode,
              isolation: opts.isolation,
              network: opts.network,
              timeout: opts.timeout,
              json: opts.json,
              global: opts.global,
              local: opts.local,
            },
            io,
          ),
        );
      },
    );

  // ---------------------------------------------------------------------
  // run
  // ---------------------------------------------------------------------

  withCommonOptions(program.command("run"))
    .description("Delegates an objective to a sub-agent, one full round trip.")
    .argument("<objective>", "The objective entrusted to the agent, in one sentence.")
    .argument(
      "[extra_args...]",
      "Raw arguments passed as-is to the agent's CLI, after \"--\". Escape hatch for what caesar does not expose: caesar run --agent codex \"…\" -- --enable feature_x",
    )
    .option("--role <name>", "Role through which to pick the agent.")
    .option("--agent <id>", "Agent to use directly (wins over --role).")
    .option("--mode <mode>", "\"read-only\" or \"write\".")
    .option(
      "--isolation <isolation>",
      "\"worktree\": dedicated workshop — a disposable branch, plus the untracked files declared under [worktree] and its setup already run. \"auto\" (default) picks it for writes as soon as a git repository allows it. \"inplace\" writes into your working tree, and is refused for writes in a usable git repository without allow_inplace_write; if the worktree seems incomplete, complete [worktree] rather than giving up on it.",
    )
    .option("--network <network>", "\"auto\" (default), \"on\" (refuses the delegation if the agent cannot open the network) or \"off\".")
    .option("--timeout <duration>", "Maximum delay, e.g. \"10m\".")
    .option("--model <model>", "Model to request from the agent, if it supports it.")
    .option("--context <text>", "Additional context. Prefix with @ to read a file (@path).")
    .option(
      "--channel",
      "Enables the MCP return channel: the sub-agent can query the main agent along the way (ask_orchestrator) instead of guessing or giving up. Adds one process per delegation.",
    )
    .action(
      async (
        objective: string,
        extraArgs: string[],
        options: GlobalOptions & {
          role?: string;
          agent?: string;
          mode?: string;
          isolation?: string;
          network?: string;
          timeout?: string;
          model?: string;
          context?: string;
          channel?: boolean;
        },
        command: Command,
      ) => {
        const opts = command.optsWithGlobals<typeof options>();
        await run(async () => {
          // Commander does not distinguish excess operands from what follows
          // "--": both land in the same variadic. Without this check,
          // `caesar run "obj" typo` would silently head to the agent, whereas
          // commander used to refuse it ("too many arguments"). It is that
          // refusal we preserve, absent written intent.
          if (extraArgs.length > 0 && !argv.includes("--")) {
            printError(
              io,
              `Unexpected arguments: ${extraArgs.join(" ")}. To pass them to the agent's CLI, separate them with "--".`,
            );
            return EXIT_USAGE;
          }
          return runRun(
            await resolveRoot(opts.root),
            objective,
            {
              extraArgs,
              role: opts.role,
              agent: opts.agent,
              mode: opts.mode,
              isolation: opts.isolation,
              network: opts.network,
              timeout: opts.timeout,
              model: opts.model,
              context: opts.context,
              json: opts.json,
              channel: opts.channel,
            },
            io,
          );
        });
      },
    );

  // ---------------------------------------------------------------------
  // ps / watch / logs / cancel / diff / apply
  // ---------------------------------------------------------------------

  withCommonOptions(program.command("watch"))
    .description("Watch the sub-agents work, live.")
    .argument("[ids...]", "Tasks to follow. Default: all those in progress.")
    .option("--once", "A single frame, then exit — for a script or a quick glance.")
    .action(async (ids: string[], options: GlobalOptions & { once?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runWatch(await resolveRoot(opts.root), ids, { json: opts.json, once: opts.once }, io));
    });

  withCommonOptions(program.command("ps"))
    .description("Lists the store's tasks (default: in progress + latest finished).")
    .option("--status <statuses>", "Filter by status(es), comma-separated.")
    .action(async (options: GlobalOptions & { status?: string }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runPs(await resolveRoot(opts.root), { status: opts.status, json: opts.json }, io));
    });

  withCommonOptions(program.command("logs"))
    .description("Shows the normalized events of a task.")
    .argument("<id>", "Task identifier")
    .option("--raw", "Raw output of the agent's CLI, rather than the normalized events.")
    .option("--follow", "Follows the task live.")
    .action(async (id: string, options: GlobalOptions & { raw?: boolean; follow?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runLogs(await resolveRoot(opts.root), id, { raw: opts.raw, follow: opts.follow, json: opts.json }, io));
    });

  withCommonOptions(program.command("cancel"))
    .description("Cancels a running task (SIGTERM to the recorded process).")
    .argument("<id>", "Task identifier")
    .action(async (id: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runCancel(await resolveRoot(opts.root), id, { json: opts.json }, io));
    });

  withCommonOptions(program.command("diff"))
    .description("Shows the diff of a task's worktree.")
    .argument("<id>", "Task identifier")
    .action(async (id: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runDiff(await resolveRoot(opts.root), id, { json: opts.json }, io));
    });

  withCommonOptions(program.command("apply"))
    .description("Applies the diff of a task's worktree to the main repository.")
    .argument("<id>", "Task identifier")
    .action(async (id: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runApply(await resolveRoot(opts.root), id, { json: opts.json }, io));
    });

  withCommonOptions(program.command("gc"))
    .description("Cleans up the worktrees and branches left by finished tasks.")
    .option("--dry-run", "Shows the removals and keeps without changing anything.")
    .option("--force", "Also removes finished worktrees carrying non-integrated modifications.")
    .action(async (options: GlobalOptions & { dryRun?: boolean; force?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runGc(await resolveRoot(opts.root), { dryRun: opts.dryRun, force: opts.force, json: opts.json }, io),
      );
    });

  // ---------------------------------------------------------------------
  // mcp
  // ---------------------------------------------------------------------

  const mcp = program
    .command("mcp")
    .description("MCP server: exposes the delegation tools to a main agent, and the registration with its clients.");

  mcp
    .command("serve")
    .description('Starts the MCP server on stdio. Nothing but the protocol writes to stdout: diagnostics go to stderr.')
    .option("--root <dir>", "Project root (default: automatic search from the current directory)")
    .action(async (options: { root?: string }) => {
      await run(async () => runMcpServe(await resolveRoot(options.root), io));
    });

  withCommonOptions(mcp.command("install"))
    .description("Registers \"caesar\" with an MCP client: claude, codex, copilot, opencode or antigravity.")
    .argument("<client>", "claude, codex, copilot, opencode or antigravity")
    .option("--dry-run", "Shows what would be done (command run or file written), without running or writing anything.")
    .action(async (client: string, options: GlobalOptions & { dryRun?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runMcpInstall(await resolveRoot(opts.root), client, { dryRun: opts.dryRun, json: opts.json }, io));
    });

  // ---------------------------------------------------------------------
  // channel (internal, task 12)
  // ---------------------------------------------------------------------

  // Hidden group: reached by self-invocation from the compiled binary (see
  // `configureChannelLauncher` in `@caesar/core` and `bun-entry.ts`), never
  // typed by hand — masked from `caesar --help` (`{ hidden: true }`), always
  // reachable explicitly (`caesar channel serve --task-dir <dir>`).
  const channel = program
    .command("channel", { hidden: true })
    .description("MCP return channel: internal subcommands, reached by self-invocation.");

  channel
    .command("serve")
    .description("Starts the return channel server on stdio, for a given task.")
    .requiredOption("--task-dir <dir>", "Task directory (contains task.json, events.jsonl…).")
    .action(async (options: { taskDir: string }) => {
      await run(async () => runChannelServe(options.taskDir));
    });

  // ---------------------------------------------------------------------
  // protocol
  // ---------------------------------------------------------------------

  const protocol = program.command("protocol").description("The @caesar/protocol standard: published JSON Schemas.");

  withCommonOptions(protocol.command("schema"))
    .description("Publishes the JSON Schema of a document of the standard (task, report, event). Without an argument: lists them.")
    .argument("[name]", "task, report or event")
    .option("--strict", "Variant for native structured outputs (report only).")
    .action(async (name: string | undefined, options: GlobalOptions & { strict?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runProtocolSchema(name, { strict: opts.strict, json: opts.json }, io));
    });

  return program;
}

/** Runs the CLI on `argv` and returns the exit code. Never calls `process.exit`. */
export async function runCli(argv: string[], io: Io = processIo): Promise<number> {
  const exitCodeRef = { value: EXIT_OK };
  const program = buildProgram(io, exitCodeRef, argv);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    // commander.help / commander.version: already written to the configured streams, exit 0.
    if (error instanceof CommanderError) {
      if (error.code.startsWith("commander.help") || error.code === "commander.version") return EXIT_OK;
      // Any other CommanderError (missing argument, unknown option…) has
      // already been written to stderr by commander itself
      // (`configureOutput`): do not reprint it, only translate its exit
      // code to the brief's (2 = usage error).
      return EXIT_USAGE;
    }
    printError(io, error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }

  return exitCodeRef.value;
}
