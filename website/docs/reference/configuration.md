---
title: Configuration
sidebar_position: 2
description: The three layered config files and how they merge, plus the full reference for [policy], [worktree], [models], [[role]] and [[agent]].
---

{/* Source: .claude/skills/caesar/references/config.md, README.md §Layered configuration: global, project, local — manual resync */}

# Configuration

## Three layers, most specific wins

| Layer | File | Tracked |
|---|---|---|
| global | `~/.config/caesar/config.toml` | no — per workstation |
| project | `<root>/.caesar/config.toml` | yes — shared with the team |
| local | `<root>/.caesar/config.local.toml` | no — per workstation, per project |

They are merged in that order at load time. A missing file is never an error: the defaults alone are a working configuration. Setting policy, roles and agents once in the global layer means every new project inherits them without doing anything — `caesar init --global` creates that layer, entirely from the default settings.

## How the merge works

The merge is not uniform, and the difference matters when editing:

- **`[policy]` and `[worktree]` merge field by field.** A layer that declares only `max_parallel` says nothing about the other fields, which keep the value of the less specific layer. Each declared field *replaces* — for the list-valued ones (`allowed`, `denied`, `copy`, `link`, `setup`) that means replacement, never union, so that a local layer can remove an entry inherited from the global one.
- **`[[role]]` and `[[agent]]` merge by key** (`name`, `id`): an entry replaces the same-key entry of a less specific layer *entirely*. Each entry must therefore be complete on its own.

Writing never flattens the merge into one layer: a configuration read by `caesar` (including `caesar policy show`) always adds up the three layers, but writing never writes that merged result back into a single one of them — a single `caesar policy deny copilot` used to copy the effective configuration into the project's file, freezing `max_parallel` and everything else along the way. `caesar policy show`, `caesar role show` and `caesar agents list` report the provenance of each value (`global`, `project`, `local`, or `default`).

**Editing `allowed`/`denied` takes over the whole list in the target layer.** Because those lists replace rather than union, `caesar policy deny X` writes the *effective* list plus `X`, never `X` alone. When the target layer did not previously declare that field, `caesar` says so — and takes ownership of it, so that changing a less specific layer afterwards no longer has any effect there:

```
$ caesar policy deny copilot --global
$ caesar init
$ caesar policy deny opencode
Agent "opencode" added to the "denied" list (project layer (.caesar/config.toml)).
Warning: the "denied" list was not declared by the project layer (.caesar/config.toml); it now takes ownership of it with the current effective value (copilot, opencode) — modifying a less specific layer (global or default) will no longer affect this field here.
```

At the end of this scenario, `.caesar/config.toml` contains only `denied = ["copilot", "opencode"]` — no copied defaults, no frozen global setting; modifying `max_parallel` in the global file afterwards keeps propagating to this project.

The commands that modify — `caesar policy allow|deny`, `caesar agents enable|disable`, `caesar agents set-model|unset-model`, `caesar role add|remove` — accept `--global`/`--local` to target a layer other than the project (the default). Mutually exclusive: `caesar` explicitly refuses `--global` and `--local` together rather than letting the last one read win in silence.

`caesar init` creates the **project** layer: the default system prompts (`.caesar/roles/*.md`), the deposit of the skill and the commands for detected runtimes, and completes the project's `.gitignore` with `.caesar/config.local.toml`, `.caesar/tasks/`, `.caesar/wt/` and `.caesar/state/`.

## `[policy]`

```toml
[policy]
allowed = []                 # empty: every agent not denied passes
denied = []
max_parallel = 4
default_isolation = "auto"   # "inplace" | "worktree" | "auto"
default_mode = "write"       # "read-only" | "write"
default_network = "auto"     # "auto" | "on" | "off"
default_timeout = "10m"
allow_recursion = false
allow_inplace_write = false
max_depth = 2
```

Those are the defaults, in force with no configuration file at all (`default_timeout = "10m"` resolves internally to `default_timeout_ms: 600000`). Two are deliberately restrictive:

- **`allow_inplace_write = false`** — a write task does not run in the user's working tree as long as a worktree is possible. The opposite default is what once let three delegations write directly to a real working branch, silently.
- **`allow_recursion = false`** — refuses the `claude` provider, since delegating to Claude from Claude is the recursion this setting guards against. It is the only policy rule that names an agent.

`default_network = "auto"` rather than `"on"`: `"on"` as a default would fail every read-only task on `codex`, whose sandbox cuts the network outside write mode — including the shipped `reviewer` and `investigator` roles.

### The four refusal rules

Checked in this order; the first refusal is the one reported. Each has its own remedy, and only its own — a generic "allow it" suggestion is wrong for three of the four.

| Rule | Condition | Remedy |
|---|---|---|
| `denied` | the agent is in `policy.denied` | `caesar agents enable <id>` — and target the layer that declares the list (`--global` / `--local`). `caesar policy allow` would *not* lift it: `denied` always wins over `allowed`. |
| `allowlist` | `policy.allowed` is non-empty and does not list the agent | `caesar policy allow <id>`. Careful: if `allowed` is empty today, this turns "every agent not denied" into "only this one", refusing all the others in the same gesture. |
| `depth` | the current delegation depth is `>= policy.max_depth` | Nothing per agent: it is the depth of the delegation in progress, not a property of the agent. Depth is inherited through `$CAESAR_DEPTH`, so a sub-agent that itself delegates is counted. |
| `recursion` | `allow_recursion` is false and the agent is `claude` | Set `allow_recursion` (Policy tab of the `caesar config` TUI, or edit the TOML) — there is no dedicated subcommand. |

Refusals happen before anything is written to disk: a refused delegation leaves no task directory behind.

### `max_parallel`

Four by default, and enforced **between processes**, not only inside one. The slots are files under `.caesar/state/slots/`, shared by everything delegating under the same project root: six terminals plus a delegating conversation all draw from the same four. A process that finds none free waits, saying who holds them.

Two limits worth knowing. The wait is a poll, not a queue: between two candidates, the one that knocks at the right moment enters, not the one that arrived first. And reclaiming a dead slot relies on the holder's pid, which means nothing across machines — a `.caesar/` on a network share used from two workstations would see the other's slots as alive indefinitely.

## `[worktree]` — the workshop

A git worktree contains only **tracked** files. Installed dependencies, `.env`, ignored directories carrying briefs or artefacts are absent from it — so nothing installs, nothing runs, nothing gets verified. That is what made isolation an empty room on real projects, and what made `inplace` look like the only practical way out.

```toml
[worktree]
copy  = ["node_modules", ".env"]    # copied — isolated from the workspace
link  = []                          # symlinked — shared, therefore NOT isolated
setup = ["pnpm install --offline"]  # run in the worktree, before the agent starts
```

`caesar init` fills this section from what it finds (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `package.json`, `Cargo.toml`, `poetry.lock`, `pyproject.toml`, `requirements.txt`, `go.mod`, `.env`, `.env.local`) and writes nothing when it finds nothing.

**Prefer `copy` over `link`.** On a copy-on-write filesystem — APFS, Btrfs, XFS — the copy is a clone and duplicates no bytes until something writes. Measured on a 975 MB `node_modules` (~100 000 files, APFS): 6.3 s and 11 MB of disk, against 15.0 s and 994 MB for an ordinary copy. Not free, since the tree still has to be walked, but it is the price of real isolation, and it compares against the `setup` run it saves. From the agent's point of view a clone is a true copy: two simultaneous tasks share nothing.

`link` exists for filesystems without copy-on-write. It shares the directory with the workspace, so two simultaneous tasks write to the same place and what one breaks it breaks for the workspace; the task's report states it explicitly as a finding.

Paths are relative to the workspace root. Absolute paths, `..` segments, and anything under `.git` or `.caesar` are refused when the file is loaded. A declared path that cannot be placed produces a **finding**, not a failure, naming the key to fix:

| Situation | Why it is skipped |
|---|---|
| absent from the workspace | nothing to place |
| tracked by git | the worktree already has its version; placing a link over it would make the sub-agent write into the main repository |
| neither tracked nor ignored | it would show up in the task's diff as the agent's work, and `caesar gc` would never clean that worktree again |
| already present in the worktree | nothing is overwritten |

`setup` commands run in the worktree through a shell, in order, after materialization and **before** the agent starts. The first failure aborts the task with the command, its exit code and its output. Whatever the orchestrator itself placed is excluded from the task's diff, with prefix semantics — a copied `.env` appears neither in `caesar diff` nor in `caesar apply`.

## `[models]` — default model per agent

```toml
[models]
codex = "gpt-5.2-codex"
claude = "claude-opus-5"
```

One key per agent id, native or declared. The value is passed to the agent's CLI (`-m`/`--model`, or the `{{model}}` token of an `[[agent]]` template) for every delegation that names no model itself. A table of its own, deliberately **not** a field on `[[agent]]`: declaring an `[[agent]]` entry with a native id replaces the native adapter entirely, capabilities included — far too heavy a gesture for a mere model preference.

Merged key by key across layers, like the fields of `[policy]`: a project layer that declares `codex` says nothing about the other agents. The same limit follows: a more specific layer cannot *cancel* an inherited key, only redeclare it — `caesar agents unset-model` removes the key from the layer that declares it (it names that layer when you target another).

An agent without the "model" capability (a generic `[[agent]]` whose `args` carry no `{{model}}`): an explicit `--model`/`model:` is **refused** before anything starts; a config-derived model (role or table) is dropped with a warning at launch and an `info` finding in the report — a delegation is never failed over a default the caller did not ask for. An empty value is refused at load time: removing a default means deleting the key, not emptying it.

Set with `caesar agents set-model <id> <model>` / `unset-model <id>` (`--global`/`--local`, project by default), shown by `caesar agents list` (the `model` column marks an inapplicable default as `(ignored)`), and editable in the [TUI](./tui.md) (key `m` on the Agents tab, `Model` field on the Roles tab).

## `[[role]]`

A role is a fallback chain plus a set of defaults. Three ship by default:

| Role | Agents, in fallback order | Mode | Isolation |
|---|---|---|---|
| `reviewer` | `codex`, `antigravity` | `read-only` | `inplace` |
| `implementer` | `codex`, `antigravity`, `opencode` | `write` | `worktree` |
| `investigator` | `antigravity`, `codex`, `opencode` | `read-only` | `auto` |

All three default to `network = "auto"` and a `10m` timeout, and each points at a system prompt file under `.caesar/roles/<name>.md` — written by `caesar init`, and tolerated as absent (the role still works, with no system prompt).

A role's system prompt is prepended to the task's `context`, separated by a horizontal rule. Its `mode`, `isolation`, `network`, optional `model` and `timeout` fill in whatever the delegation did not state explicitly. The chain is walked in declaration order, skipping agents whose binary is not installed and agents the policy refuses; `caesar role list` and `caesar_list_roles` both show which one would be picked right now and why the earlier candidates were skipped.

A role's `model` applies to **whichever agent the fallback elects** — model names belong to each provider, so a chain mixing providers only makes sense with a name they all accept, or a single agent. It beats the `[models]` per-agent default and loses to an explicit `--model`/`model:`.

## `[[agent]]` — wiring a CLI outside the catalogue

```toml
[[agent]]
id = "my-agent"
bin = "my-agent-cli"
args = ["--task-file", "{{taskDir}}/task.json", "--out", "{{reportPath}}", "--cwd", "{{workspace}}", "{{prompt}}"]
cwd_mode = "process"          # "process": the workspace is the process cwd. "flag": already carried by a token in args.
display_name = "My Agent"     # optional
native_read_only = true       # optional: the CLI enforces read-only itself
network_args = ["--online"]   # optional: what to add to open the network
```

Substituted tokens: `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}`, `{{model}}`. A token with no value removes its whole argument rather than leaving a residue. `{{prompt}}` is mandatory.

`native_read_only` is the only capability declarable here, and that is deliberate: it is the only one the engine can honour without the command line cooperating (it decides whether a read-only task must be isolated in a worktree). Declaring `network_args` asserts that **without** those arguments the CLI is confined — the agent's network capability then moves from "unknown" to "controllable".

A declared agent otherwise has no capabilities: no native output schema, no MCP channel. It uses the most tolerant report tier, which asks only that it read `$CAESAR_TASK_FILE` and write `$CAESAR_REPORT_PATH`. See the [OACP overview](../protocol/overview.md).

## Resolving the model

First hit wins:

1. explicit `--model` (`caesar run`) or `model:` (`caesar_delegate`);
2. the role's `model`;
3. `[models].<agent>` — looked up for the agent the delegation actually elected;
4. nothing: the provider's own default.

## Next steps

- [CLI reference](./cli.md) — the `caesar agents`, `caesar policy` and `caesar role` commands that edit this file.
- [TUI](./tui.md) — editing policy, roles, agents and models interactively.
- [Troubleshooting](../troubleshooting.md) — what a refusal looks like, and how to fix it.
