# The `orch` command line

Sixteen commands, grouped as `orch --help` groups them: by the order in which they are met, not by
declaration order. `orch <command> --help` prints the detail of one.

The CLI and the delegation tools are two façades over the same engine. Use the CLI for what the
tools do not expose: inspecting configuration, editing policy and roles, garbage-collecting
worktrees, and passing raw arguments through to a provider.

## Getting started

| Command | Arguments and flags |
|---|---|
| `orch init` | `--force` (overwrite an existing configuration), `--global` (write `~/.config/orch/config.toml` instead of the project layer) |
| `orch doctor` | `--verbose` (adds the binary path and spelled-out capabilities) |
| `orch config` | none — launches the interactive configuration TUI |

`orch init` creates `<root>/.orch/config.toml` and the default system prompt of every role.
`orch doctor` reports, per catalogue agent: presence, version, capabilities, and its status under
the effective policy.

## Delegating

| Command | Arguments and flags |
|---|---|
| `orch run <objective> [extra_args...]` | `--role <name>`, `--agent <id>`, `--mode <read-only\|write>`, `--isolation <inplace\|worktree\|auto>`, `--network <auto\|on\|off>`, `--timeout <duration>`, `--model <model>`, `--context <text or @file>`, `--channel` |
| `orch watch [ids...]` | `--once` (one frame, then exit) |

`orch run` is a full round trip: it delegates, waits, and prints the report. At least one of
`--agent` / `--role` is required; `--agent` wins over the agent a `--role` would have picked, while
the role's other defaults still apply. `--context @path` reads the file at `path` (relative to the
current directory) and inlines it. `--timeout` accepts `10m`, `90s`, `1h`, or a bare integer of
milliseconds.

`orch watch` with no id follows every task currently running. Without `--once` it is an interactive
terminal view that redraws and does not exit on its own — for a human, not for a program. With
`--once` it prints a single snapshot and returns; with `--json` it emits NDJSON of the merged event
streams.

### The mandatory `--` of `orch run`

Everything `orch` does not expose can be appended raw to the provider's own command line, after a
`--` separator:

```bash
orch run --agent codex "…" -- --enable feature_x
```

The separator is required. Commander cannot distinguish surplus operands from what follows `--`, so
without it `orch run "objective" typo` would silently forward `typo` to the provider; instead the
command refuses with exit code 2 and names the unexpected arguments.

This escape hatch is **deliberately absent from `orch_delegate`**: it is a gesture a human types,
not a latitude granted to an orchestrating model, which could otherwise raise a sub-agent's
privileges on its own.

## Following tasks

| Command | Arguments and flags |
|---|---|
| `orch ps` | `--status <statuses>` — comma-separated, from `pending`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out` |
| `orch logs <id>` | `--raw` (the provider's raw CLI output instead of normalized events), `--follow` (live) |
| `orch cancel <id>` | none |
| `orch diff <id>` | none |
| `orch apply <id>` | none |
| `orch gc` | `--dry-run` (show removals and retentions, change nothing), `--force` (also remove finished worktrees carrying unintegrated changes) |

Without `--status`, `orch ps` lists everything still active plus the ten most recently finished
tasks. It prints the process status and the report status in separate columns, because they answer
different questions. An unknown status name is an error (exit code 2), not a silently empty filter.

`orch cancel` sends `SIGTERM` to the recorded pid. On an already finished task it reports that there
was nothing to cancel; if the pid no longer exists, the task is marked `cancelled`.

`orch logs --follow` returns on its own once the task leaves an active status — it does not need to
be interrupted.

`orch apply` applies a worktree task's diff to the main repository with `git apply --3way`. It never
commits and never touches branches.

## Configuring

| Command | Arguments and flags |
|---|---|
| `orch agents list` | — |
| `orch agents enable <id>` | scope flags |
| `orch agents disable <id>` | scope flags |
| `orch agents add <id>` | `--bin <command>` (**required**), `--args <template>` (default `{{prompt}}`), `--display-name <name>`, `--cwd-mode <process\|flag>` (default `process`), `--read-only-native`, scope flags |
| `orch agents remove <id>` | scope flags |
| `orch agents test <id>` | `--yes` (**required** — the test runs a real read-only micro-task and consumes the provider's quota) |
| `orch policy show` | — (prints the effective policy with the provenance of each value) |
| `orch policy allow <id>` | scope flags |
| `orch policy deny <id>` | scope flags |
| `orch role list` | — (with the agent each role would pick today) |
| `orch role show <name>` | — (system prompt included) |
| `orch role add <name>` | `--purpose <text>`, `--agents <ids>` (comma-separated, in fallback order), `--mode <read-only\|write>`, `--isolation <inplace\|worktree\|auto>`, `--network <auto\|on\|off>`, `--timeout <duration>`, scope flags |
| `orch role remove <name>` | scope flags |

**Scope flags** — `--global` (the global layer) and `--local` (the project's untracked local layer)
are accepted by every command that writes. Without either, the project layer is targeted. They are
mutually exclusive and refused together rather than letting the last one read win.

The substitutable tokens of `orch agents add --args` are `{{prompt}}`, `{{workspace}}`,
`{{taskDir}}`, `{{reportPath}}` and `{{model}}`. The first is mandatory: without it the declared CLI
never receives the objective. See `references/protocol.md`.

## Integrating

| Command | Arguments and flags |
|---|---|
| `orch mcp serve` | `--root <dir>` only |
| `orch mcp install <client>` | `<client>` is one of `claude`, `codex`, `copilot`, `opencode`, `antigravity`; `--dry-run` shows the command that would run or the file that would be written |
| `orch protocol schema [name]` | `[name]` is `task`, `report` or `event` — with no argument, they are listed; `--strict` selects the variant for native structured outputs (`report` only) |

`orch mcp serve` speaks the MCP protocol on stdout and nothing else; diagnostics go to stderr.

## `--root` and `--json`

`--root <dir>` sets the project root and is accepted by **every** command. Without it the root is
found by walking up from the current directory to the first `.orch/` or `.git/`.

`--json` produces machine output with no colour and no formatting, and is accepted by every command
**except two**:

- `orch mcp serve` does not know the flag at all (`unknown option`) — that command must write
  nothing but the MCP protocol on stdout;
- `orch config` refuses it explicitly with exit code 2 — it launches an interactive TUI, so there is
  no machine output to produce. Accepting it silently would suggest it had been honoured.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | runtime failure (I/O, subprocess, a delegated task that did not succeed) |
| `2` | usage or configuration error (bad flag, unknown role or agent, policy refusal, malformed TOML) |

`orch run` **crosses both statuses** before returning `0`: the process must have exited `succeeded`
*and* the report must say `success`. A sub-agent that writes `{"status":"failed"}` and still exits
`0` therefore yields exit code `1`, not `0` — otherwise a script chaining on `orch run` would
conclude success on a task the agent itself declared failed.
