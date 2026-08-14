# The `caesar` command line

Sixteen commands, grouped as `caesar --help` groups them: by the order in which they are met, not by
declaration order. `caesar <command> --help` prints the detail of one.

The CLI and the delegation tools are two façades over the same engine. Use the CLI for what the
tools do not expose: inspecting configuration, editing policy and roles, garbage-collecting
worktrees, and passing raw arguments through to a provider.

## Invocation

`caesar` is a standalone binary on the PATH — never a dependency of the project. `npx caesar` always
fails with `could not determine executable to run`, whatever the project's `package.json` says:
call `caesar` directly. When in doubt, `command -v caesar` says where it lives and `caesar doctor` says
what it can reach.

## Getting started

| Command | Arguments and flags |
|---|---|
| `caesar init` | `--force` (overwrite an existing configuration), `--global` (write `~/.config/caesar/config.toml` instead of the project layer), `--agent <id>` (repeatable — force these targets instead of PATH detection), `--no-skills` (skip depositing/refreshing the agentic assets, not remembered) |
| `caesar doctor` | `--verbose` (adds the binary path and spelled-out capabilities) |
| `caesar config` | none — launches the interactive configuration TUI |

`caesar init` creates `<root>/.caesar/config.toml` and the default system prompt of every role, and
deposits the skill for every `claude`/`codex`/`copilot`/`opencode`/`antigravity` binary found on
the PATH, plus slash-commands for the two runtimes that support them (`claude`, `opencode`) —
`--agent` overrides that detection with an explicit list instead (validated against the same five
ids); with none
detected and no `--agent`, the shared `.agents/skills/caesar/` location is still deposited, ready for
whichever of the four non-`claude` runtimes gets installed next. On a project already initialized,
re-running `caesar init` **without** `--force` refreshes only the assets: `.caesar/config.toml` and
`.caesar/roles/*.md` are left byte-for-byte untouched (they are what the user edits) and the command
still exits `0`. `--force` restores the original all-or-nothing behaviour: it also rewrites the
configuration and every role prompt from scratch. `--global` writes under the user's home directory
instead of the project root and is never committed to git — the project layer, by contrast, is
versioned and shared with the team. `--json` adds an `assets` key (`{ targets, files, stale }`, or
`null` under `--no-skills`) to the existing output, in both scopes.

`caesar doctor` reports, per catalogue agent: presence, version, capabilities, and its status under
the effective policy.

## Delegating

| Command | Arguments and flags |
|---|---|
| `caesar run <objective> [extra_args...]` | `--role <name>`, `--agent <id>`, `--mode <read-only\|write>`, `--isolation <inplace\|worktree\|auto>`, `--network <auto\|on\|off>`, `--timeout <duration>`, `--model <model>`, `--context <text or @file>`, `--channel` |
| `caesar watch [ids...]` | `--once` (one frame, then exit) |

`caesar run` is a full round trip: it delegates, waits, and prints the report. At least one of
`--agent` / `--role` is required; `--agent` wins over the agent a `--role` would have picked, while
the role's other defaults still apply. `--context @path` reads the file at `path` (relative to the
current directory) and inlines it. `--timeout` accepts `10m`, `90s`, `1h`, or a bare integer of
milliseconds.

`caesar watch` with no id follows every task currently running. Without `--once` it is an interactive
terminal view that redraws and does not exit on its own — for a human, not for a program. With
`--once` it prints a single snapshot and returns; with `--json` it emits NDJSON of the merged event
streams.

### The mandatory `--` of `caesar run`

Everything `caesar` does not expose can be appended raw to the provider's own command line, after a
`--` separator:

```bash
caesar run --agent codex "…" -- --enable feature_x
```

The separator is required. Commander cannot distinguish surplus operands from what follows `--`, so
without it `caesar run "objective" typo` would silently forward `typo` to the provider; instead the
command refuses with exit code 2 and names the unexpected arguments.

This escape hatch is **deliberately absent from `caesar_delegate`**: it is a gesture a human types,
not a latitude granted to an orchestrating model, which could otherwise raise a sub-agent's
privileges on its own.

## Following tasks

| Command | Arguments and flags |
|---|---|
| `caesar ps` | `--status <statuses>` — comma-separated, from `pending`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out` |
| `caesar logs <id>` | `--raw` (the provider's raw CLI output instead of normalized events), `--follow` (live) |
| `caesar cancel <id>` | none |
| `caesar diff <id>` | none |
| `caesar apply <id>` | none |
| `caesar gc` | `--dry-run` (show removals and retentions, change nothing), `--force` (also remove finished worktrees carrying unintegrated changes) |

Without `--status`, `caesar ps` lists everything still active plus the ten most recently finished
tasks. It prints the process status and the report status in separate columns, because they answer
different questions. An unknown status name is an error (exit code 2), not a silently empty filter.

`caesar cancel` sends `SIGTERM` to the recorded pid. On an already finished task it reports that there
was nothing to cancel; if the pid no longer exists, the task is marked `cancelled`.

`caesar logs --follow` returns on its own once the task leaves an active status — it does not need to
be interrupted.

`caesar apply` applies a worktree task's diff to the main repository with `git apply --3way`. It never
commits and never touches branches.

`caesar gc` removes the worktrees and branches of finished tasks. A worktree whose diff was applied
(`caesar apply`) is collected as long as nothing changed in it since the application — the
application is recorded on the task, so gc never has to guess. What it keeps is exactly the work
that was never applied, or modified after it: settle it with `caesar diff`/`caesar apply`, or discard
it knowingly with `--force`.

## Configuring

| Command | Arguments and flags |
|---|---|
| `caesar agents list` | — |
| `caesar agents enable <id>` | scope flags |
| `caesar agents disable <id>` | scope flags |
| `caesar agents add <id>` | `--bin <command>` (**required**), `--args <template>` (default `{{prompt}}`), `--display-name <name>`, `--cwd-mode <process\|flag>` (default `process`), `--read-only-native`, scope flags |
| `caesar agents remove <id>` | scope flags |
| `caesar agents test <id>` | `--yes` (**required** — the test runs a real read-only micro-task and consumes the provider's quota) |
| `caesar policy show` | — (prints the effective policy with the provenance of each value) |
| `caesar policy allow <id>` | scope flags |
| `caesar policy deny <id>` | scope flags |
| `caesar role list` | — (with the agent each role would pick today) |
| `caesar role show <name>` | — (system prompt included) |
| `caesar role add <name>` | `--purpose <text>`, `--agents <ids>` (comma-separated, in fallback order), `--mode <read-only\|write>`, `--isolation <inplace\|worktree\|auto>`, `--network <auto\|on\|off>`, `--timeout <duration>`, scope flags |
| `caesar role remove <name>` | scope flags |

**Scope flags** — `--global` (the global layer) and `--local` (the project's untracked local layer)
are accepted by every command that writes. Without either, the project layer is targeted. They are
mutually exclusive and refused together rather than letting the last one read win.

The substitutable tokens of `caesar agents add --args` are `{{prompt}}`, `{{workspace}}`,
`{{taskDir}}`, `{{reportPath}}` and `{{model}}`. The first is mandatory: without it the declared CLI
never receives the objective. See `references/protocol.md`.

## Integrating

| Command | Arguments and flags |
|---|---|
| `caesar mcp serve` | `--root <dir>` only |
| `caesar mcp install <client>` | `<client>` is one of `claude`, `codex`, `copilot`, `opencode`, `antigravity`; `--dry-run` shows the command that would run or the file that would be written |
| `caesar protocol schema [name]` | `[name]` is `task`, `report` or `event` — with no argument, they are listed; `--strict` selects the variant for native structured outputs (`report` only) |

`caesar mcp serve` speaks the MCP protocol on stdout and nothing else; diagnostics go to stderr.

## `--root` and `--json`

`--root <dir>` sets the project root and is accepted by **every** command. Without it the root is
found by walking up from the current directory to the first `.caesar/` or `.git/`.

`--json` produces machine output with no colour and no formatting, and is accepted by every command
**except two**:

- `caesar mcp serve` does not know the flag at all (`unknown option`) — that command must write
  nothing but the MCP protocol on stdout;
- `caesar config` refuses it explicitly with exit code 2 — it launches an interactive TUI, so there is
  no machine output to produce. Accepting it silently would suggest it had been honoured.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | runtime failure (I/O, subprocess, a delegated task that did not succeed) |
| `2` | usage or configuration error (bad flag, unknown role or agent, policy refusal, malformed TOML) |

`caesar run` **crosses both statuses** before returning `0`: the process must have exited `succeeded`
*and* the report must say `success`. A sub-agent that writes `{"status":"failed"}` and still exits
`0` therefore yields exit code `1`, not `0` — otherwise a script chaining on `caesar run` would
conclude success on a task the agent itself declared failed.
