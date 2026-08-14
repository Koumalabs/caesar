---
title: CLI reference
sidebar_position: 1
description: The 16 caesar commands, grouped by use, with synopses, notable flags, and the --root/--json/exit-code conventions shared by all of them.
---

{/* Source: .claude/skills/caesar/references/cli.md — manual resync */}

# CLI reference

caesar exposes sixteen commands, grouped the way `caesar --help` groups them — by the order in which they are met, not by declaration order. `caesar <command> --help` prints the detail of any one. The CLI and the MCP delegation tools are two façades over the same engine: use the CLI for what the tools do not expose — inspecting configuration, editing policy and roles, garbage-collecting worktrees, and passing raw arguments through to a provider.

## Invocation

`caesar` is a standalone binary on the PATH — never a dependency of the project. `npx caesar` always fails with `could not determine executable to run`, whatever the project's `package.json` says: call `caesar` directly. When in doubt, `command -v caesar` says where it lives and `caesar doctor` says what it can reach.

## Getting started

### `init`

Synopsis: `caesar init [--force] [--global] [--agent <id>...] [--no-skills]`

Creates `<root>/.caesar/config.toml` and the default system prompt for every role, and deposits the skill for every `claude`/`codex`/`copilot`/`opencode`/`antigravity` binary found on the PATH, plus slash-commands for the two runtimes that support them (`claude`, `opencode`).

- `--force` — overwrites an existing configuration: rewrites the configuration and every role prompt from scratch.
- `--global` — writes `~/.config/caesar/config.toml` instead of the project layer; never committed to git, unlike the project layer.
- `--agent <id>` (repeatable) — forces these targets instead of PATH detection, validated against the same five ids. With none detected and no `--agent`, the shared `.agents/skills/caesar/` location is still deposited, ready for whichever non-`claude` runtime gets installed next.
- `--no-skills` — skips depositing/refreshing the agentic assets (not remembered across runs).

On a project already initialized, re-running `caesar init` **without** `--force` refreshes only the assets: `.caesar/config.toml` and `.caesar/roles/*.md` are left byte-for-byte untouched (they are what the user edits) and the command still exits `0`. `--json` adds an `assets` key (`{ targets, files, stale }`, or `null` under `--no-skills`) to the existing output, in both scopes.

### `doctor`

Synopsis: `caesar doctor [--verbose]`

Reports, per catalogue agent: presence, version, capabilities, and its status under the effective policy. `--verbose` adds the binary path and spelled-out capabilities.

### `config`

Synopsis: `caesar config`

Launches the interactive configuration TUI — see [TUI](./tui.md). No flags of its own; it refuses `--json` explicitly (exit code 2), since an interactive TUI has no machine output to produce.

## Delegating

### `run`

Synopsis: `caesar run <objective> [extra_args...] [--role <name>] [--agent <id>] [--mode <read-only|write>] [--isolation <inplace|worktree|auto>] [--network <auto|on|off>] [--timeout <duration>] [--model <model>] [--context <text or @file>] [--channel]`

A full round trip: it delegates, waits, and prints the report. At least one of `--agent` / `--role` is required; `--agent` wins over the agent a `--role` would have picked, while the role's other defaults still apply. `--context @path` reads the file at `path` (relative to the current directory) and inlines it. `--timeout` accepts `10m`, `90s`, `1h`, or a bare integer of milliseconds.

:::note The mandatory `--`
Everything `caesar` does not expose can be appended raw to the provider's own command line, after a `--` separator:

```bash
caesar run --agent codex "…" -- --enable feature_x
```

The separator is required. Commander cannot distinguish surplus operands from what follows `--`, so without it `caesar run "objective" typo` would silently forward `typo` to the provider; instead the command refuses with exit code 2 and names the unexpected arguments. This escape hatch is deliberately absent from `caesar_delegate`: it is a gesture a human types, not a latitude granted to an orchestrating model, which could otherwise raise a sub-agent's privileges on its own.
:::

### `watch`

Synopsis: `caesar watch [ids...] [--once]`

With no id, follows every task currently running. Without `--once` it is an interactive terminal view that redraws and does not exit on its own — for a human, not for a program. With `--once` it prints a single snapshot and returns; with `--json` it emits NDJSON of the merged event streams.

## Following tasks

### `ps`

Synopsis: `caesar ps [--status <statuses>]`

Without `--status`, lists everything still active plus the ten most recently finished tasks. `--status` takes a comma-separated list from `pending`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out` — an unknown status name is an error (exit code 2), not a silently empty filter. Prints the process status and the report status in separate columns, because they answer different questions.

### `logs`

Synopsis: `caesar logs <id> [--raw] [--follow]`

`--raw` returns the provider's raw CLI output instead of normalized events; `--follow` tails live and returns on its own once the task leaves an active status — it does not need to be interrupted.

### `cancel`

Synopsis: `caesar cancel <id>`

Sends `SIGTERM` to the recorded pid. On an already finished task it reports that there was nothing to cancel; if the pid no longer exists, the task is marked `cancelled`.

### `diff`

Synopsis: `caesar diff <id>`

Shows what a worktree task changed, before anything reaches the main repository.

### `apply`

Synopsis: `caesar apply <id>`

Applies a worktree task's diff to the main repository with `git apply --3way`. Never commits and never touches branches.

### `gc`

Synopsis: `caesar gc [--dry-run] [--force]`

Removes the worktrees and branches of finished tasks. A worktree whose diff was applied (`caesar apply`) is collected as long as nothing changed in it since the application — the application is recorded on the task, so `gc` never has to guess. What it keeps is exactly the work that was never applied, or modified after it: settle it with `caesar diff`/`caesar apply`, or discard it knowingly with `--force`, which also removes finished worktrees carrying unintegrated changes. `--dry-run` shows removals and retentions without changing anything.

## Configuring

### `agents`

Subcommands: `list`, `enable <id>`, `disable <id>`, `add <id>`, `remove <id>`, `set-model <id> <model>`, `unset-model <id>`, `test <id>`.

- `list` — the agent catalog: presence, capabilities, authorization.
- `enable <id>` / `disable <id>` — accept the scope flags below.
- `add <id>` — `--bin <command>` (**required**), `--args <template>` (default `{{prompt}}`), `--display-name <name>`, `--cwd-mode <process|flag>` (default `process`), `--read-only-native`, scope flags.
- `remove <id>` — scope flags.
- `set-model <id> <model>` — the default model for this agent (`[models]` table); beaten by a role's `model`, then by an explicit `--model`.
- `unset-model <id>` — removes the key from the targeted layer; names the declaring layer when you target another.
- `test <id>` — `--yes` (**required**): the test runs a real read-only micro-task and consumes the provider's quota.

The substitutable tokens of `caesar agents add --args` are `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}` and `{{model}}`. The first is mandatory: without it the declared CLI never receives the objective. See [Configuration](./configuration.md).

### `policy`

Subcommands: `show`, `allow <id>`, `deny <id>`.

- `show` — prints the effective policy with the provenance of each value.
- `allow <id>` / `deny <id>` — scope flags.

### `role`

Subcommands: `list`, `show <name>`, `add <name>`, `remove <name>`.

- `list` — with the agent each role would pick today.
- `show <name>` — system prompt included.
- `add <name>` — `--purpose <text>`, `--agents <ids>` (comma-separated, in fallback order), `--mode <read-only|write>`, `--isolation <inplace|worktree|auto>`, `--network <auto|on|off>`, `--model <model>`, `--timeout <duration>`, scope flags.
- `remove <name>` — scope flags.

:::note Scope flags
`--global` (the global layer) and `--local` (the project's untracked local layer) are accepted by every command that writes. Without either, the project layer is targeted. They are mutually exclusive and refused together rather than letting the last one read win.
:::

## Integrating

### `mcp serve`

Synopsis: `caesar mcp serve [--root <dir>]`

Speaks the MCP protocol on stdout and nothing else; diagnostics go to stderr.

### `mcp install`

Synopsis: `caesar mcp install <client> [--dry-run]`

`<client>` is one of `claude`, `codex`, `copilot`, `opencode`, `antigravity`. `--dry-run` shows the command that would run or the file that would be written.

### `protocol schema`

Synopsis: `caesar protocol schema [name] [--strict]`

`[name]` is `task`, `report` or `event` — with no argument, they are listed. `--strict` selects the variant for native structured outputs (`report` only). See the [OACP specification](../protocol/specification.md).

## `--root` and `--json`

`--root <dir>` sets the project root and is accepted by **every** command. Without it the root is found by walking up from the current directory to the first `.caesar/` or `.git/`.

`--json` produces machine output with no colour and no formatting, and is accepted by every command **except two**:

- `caesar mcp serve` does not know the flag at all (`unknown option`) — that command must write nothing but the MCP protocol on stdout;
- `caesar config` refuses it explicitly with exit code 2 — it launches an interactive TUI, so there is no machine output to produce. Accepting it silently would suggest it had been honoured.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | runtime failure (I/O, subprocess, a delegated task that did not succeed) |
| `2` | usage or configuration error (bad flag, unknown role or agent, policy refusal, malformed TOML) |

`caesar run` **crosses both statuses** before returning `0`: the process must have exited `succeeded` *and* the report must say `success`. A sub-agent that writes `{"status":"failed"}` and still exits `0` therefore yields exit code `1`, not `0` — otherwise a script chaining on `caesar run` would conclude success on a task the agent itself declared failed.

## Next steps

- [Configuration](./configuration.md) — the three layers, `[policy]`, `[[role]]`, `[[agent]]`, `[models]`.
- [MCP tools](./mcp-tools.md) — the ten tools that expose delegation to an MCP client instead of a terminal.
- [Troubleshooting](../troubleshooting.md) — what a refusal looks like, and how to fix it.
