# Configuration

## Three layers, most specific wins

| Layer | File | Tracked |
|---|---|---|
| global | `~/.config/caesar/config.toml` | no — per workstation |
| project | `<root>/.caesar/config.toml` | yes — shared with the team |
| local | `<root>/.caesar/config.local.toml` | no — per workstation, per project |

They are merged in that order at load time. A missing file is never an error: the defaults alone are
a working configuration.

The merge is not uniform, and the difference matters when editing:

- **`[policy]` and `[worktree]` merge field by field.** A layer that declares only `max_parallel`
  says nothing about the other fields, which keep the value of the less specific layer. Each declared
  field *replaces* — for the list-valued ones (`allowed`, `denied`, `copy`, `link`, `setup`) that
  means replacement, never union, so that a local layer can remove an entry inherited from the
  global one.
- **`[[role]]` and `[[agent]]` merge by key** (`name`, `id`): an entry replaces the same-key entry of
  a less specific layer *entirely*. Each entry must therefore be complete on its own.

Writing never flattens the merge into one layer. `caesar policy show`, `caesar role show` and
`caesar agents list` report the provenance of each value (`global`, `project`, `local`, or `default`).

**Editing `allowed`/`denied` takes over the whole list in the target layer.** Because those lists
replace rather than union, `caesar policy deny X` writes the *effective* list plus `X`, never `X`
alone. When the target layer did not previously declare that field, `caesar` says so: from then on,
changing a less specific layer has no effect on that field there.

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

Those are the defaults, in force with no configuration file at all. Two are deliberately restrictive:

- **`allow_inplace_write = false`** — a write task does not run in the user's working tree as long as
  a worktree is possible. The opposite default is what once let three delegations write directly to a
  real working branch, silently.
- **`allow_recursion = false`** — refuses the `claude` provider, since delegating to Claude from
  Claude is the recursion this setting guards against. It is the only policy rule that names an agent.

`default_network = "auto"` rather than `"on"`: `"on"` as a default would fail every read-only task on
`codex`, whose sandbox cuts the network outside write mode — including the shipped `reviewer` and
`investigator` roles.

## The four refusal rules

Checked in this order; the first refusal is the one reported. Each has its own remedy, and only its
own — a generic "allow it" suggestion is wrong for three of the four.

| Rule | Condition | Remedy |
|---|---|---|
| `denied` | the agent is in `policy.denied` | `caesar agents enable <id>` — and target the layer that declares the list (`--global` / `--local`). `caesar policy allow` would *not* lift it: `denied` always wins over `allowed`. |
| `allowlist` | `policy.allowed` is non-empty and does not list the agent | `caesar policy allow <id>`. Careful: if `allowed` is empty today, this turns "every agent not denied" into "only this one", refusing all the others in the same gesture. |
| `depth` | the current delegation depth is `>= policy.max_depth` | Nothing per agent: it is the depth of the delegation in progress, not a property of the agent. Depth is inherited through `$CAESAR_DEPTH`, so a sub-agent that itself delegates is counted. |
| `recursion` | `allow_recursion` is false and the agent is `claude` | Set `allow_recursion` (policy tab of the `caesar config` TUI, or edit the TOML) — there is no dedicated subcommand. |

Refusals happen before anything is written to disk: a refused delegation leaves no task directory
behind.

## `[[role]]`

A role is a fallback chain plus a set of defaults. Three ship by default:

| Role | Agents, in fallback order | Mode | Isolation |
|---|---|---|---|
| `reviewer` | `codex`, `antigravity` | `read-only` | `inplace` |
| `implementer` | `codex`, `antigravity`, `opencode` | `write` | `worktree` |
| `investigator` | `antigravity`, `codex`, `opencode` | `read-only` | `auto` |

All three default to `network = "auto"` and a `10m` timeout, and each points at a system prompt file
under `.caesar/roles/<name>.md` — written by `caesar init`, and tolerated as absent (the role still
works, with no system prompt).

A role's system prompt is prepended to the task's `context`, separated by a horizontal rule. Its
`mode`, `isolation`, `network` and `timeout` fill in whatever the delegation did not state
explicitly. The chain is walked in declaration order, skipping agents whose binary is not installed
and agents the policy refuses; `caesar role list` and `caesar_list_roles` both show which one would be
picked right now and why the earlier candidates were skipped.

## `[worktree]` — the workshop

A git worktree contains only **tracked** files. Installed dependencies, `.env`, ignored directories
carrying briefs or artefacts are absent from it — so nothing installs, nothing runs, nothing gets
verified. That is what made isolation an empty room on real projects, and what made `inplace` look
like the only practical way out. Hardening the rule without making the worktree habitable would only
have moved the workaround.

```toml
[worktree]
copy  = ["node_modules", ".env"]    # copied — isolated from the workspace
link  = []                          # symlinked — shared, therefore NOT isolated
setup = ["pnpm install --offline"]  # run in the worktree, before the agent starts
```

`caesar init` fills this section from what it finds (`pnpm-lock.yaml`, `yarn.lock`,
`package-lock.json`, `package.json`, `Cargo.toml`, `poetry.lock`, `pyproject.toml`,
`requirements.txt`, `go.mod`, `.env`, `.env.local`) and writes nothing when it finds nothing.

**Prefer `copy` over `link`.** On a copy-on-write filesystem — APFS, Btrfs, XFS — the copy is a
clone and duplicates no bytes until something writes. Measured on a 975 MB `node_modules`
(~100 000 files, APFS): 6.3 s and 11 MB of disk, against 15.0 s and 994 MB for an ordinary copy. Not
free, since the tree still has to be walked, but it is the price of real isolation, and it compares
against the `setup` run it saves. From the agent's point of view a clone is a true copy: two
simultaneous tasks share nothing.

`link` exists for filesystems without copy-on-write. It shares the directory with the workspace, so
two simultaneous tasks write to the same place and what one breaks it breaks for the workspace; the
task's report states it explicitly as a finding.

Paths are relative to the workspace root. Absolute paths, `..` segments, and anything under `.git`
or `.caesar` are refused when the file is loaded — the worktree exists precisely so that repository and
orchestrator administration are not touched.

A declared path that cannot be placed produces a **finding**, not a failure, naming the key to fix:

| Situation | Why it is skipped |
|---|---|
| absent from the workspace | nothing to place |
| tracked by git | the worktree already has its version; placing a link over it would make the sub-agent write into the main repository |
| neither tracked nor ignored | it would show up in the task's diff as the agent's work, and `caesar gc` would never clean that worktree again |
| already present in the worktree | nothing is overwritten |

`setup` commands run in the worktree through a shell, in order, after materialization and **before**
the agent starts. The first failure aborts the task with the command, its exit code and its output:
better not to start than to hand over a half-built workshop where the agent would spend its budget
repairing an installation.

Whatever the orchestrator itself placed is excluded from the task's diff, with prefix semantics — a
copied `.env` appears neither in `caesar diff` nor in `caesar apply`.

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

Substituted tokens: `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}`, `{{model}}`. A
token with no value removes its whole argument rather than leaving a residue. `{{prompt}}` is
mandatory.

`native_read_only` is the only capability declarable here, and that is deliberate: it is the only one
the engine can honour without the command line cooperating (it decides whether a read-only task must
be isolated in a worktree). Declaring `network_args` asserts that **without** those arguments the CLI
is confined — the agent's network capability then moves from "unknown" to "controllable".

A declared agent otherwise has no capabilities: no native output schema, no MCP channel. It uses the
most tolerant report tier, which asks only that it read `$CAESAR_TASK_FILE` and write
`$CAESAR_REPORT_PATH`. See `references/protocol.md`.

## `max_parallel`

Four by default, and enforced **between processes**, not only inside one. The slots are files under
`.caesar/state/slots/`, shared by everything delegating under the same project root: six terminals plus
a delegating conversation all draw from the same four. A process that finds none free waits, saying
who holds them.

Two limits worth knowing. The wait is a poll, not a queue: between two candidates, the one that
knocks at the right moment enters, not the one that arrived first. And reclaiming a dead slot relies
on the holder's pid, which means nothing across machines — an `.caesar/` on a network share used from
two workstations would see the other's slots as alive indefinitely.
