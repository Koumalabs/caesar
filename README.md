# caesar

An orchestrator that lets a coding agent — typically Claude Code — delegate tasks to **external** sub-agents (Codex, Antigravity, OpenCode, Copilot, or even another Claude Code instance) run as plain CLI processes, exactly the way it would delegate to a native sub-agent.

The problem it solves: every coding-agent CLI has its own way of receiving a mission, returning a report, and signaling that it needs a clarification. Without a common layer, comparing two providers on the same task, or simply making a round-trip with one of them reliable, means relearning its format every time — and taking its word for what it claims to have modified. `caesar` normalizes that cycle: a common communication standard (`docs/protocol.md`), an engine that isolates each task on a disposable git worktree, and a systematic reconciliation between what the agent declares and what `git diff` observes — the diff is the source of truth, never the agent's claim alone.

This repository ships a CLI (`caesar`), a ten-tool MCP server to drive all of it from Claude Code (or any other MCP client), a configuration TUI, and a multi-runtime `caesar` skill accompanied by five commands — what `caesar init` deposits with the main agent (Claude Code, Codex, Copilot CLI, OpenCode, Antigravity CLI) so it knows how to direct `caesar` rather than execute it itself (see "[Using from Claude Code](#using-from-claude-code)").

## Supported agents

| Agent | Identifier | Expected binary | Headless mode | Network |
|---|---|---|---|---|
| Codex | `codex` | `codex` | `codex exec --json -s <read-only\|workspace-write> …` | write mode only |
| Antigravity CLI | `antigravity` | `agy` | `agy --print <prompt> --output-format stream-json --mode <plan\|accept-edits> …` | open |
| OpenCode | `opencode` | `opencode` | `opencode run --format json --dir <workspace> …` | open |
| GitHub Copilot CLI | `copilot` | `copilot` | `copilot --prompt <prompt> --output-format json --no-color --log-level none …` | controllable |
| Claude Code | `claude` | `claude` | `claude --print <prompt> --output-format stream-json --verbose --permission-mode <plan\|acceptEdits> …` | open |

The full flag details (native output schema, MCP channel, model, additional directories…) live in `packages/core/src/adapters/*.ts`, one file per agent — every flag there was verified with `--help` on a real machine, none is invented.

The **Network** column says what `caesar` knows how to *control*, not what the agent is capable of — the distinction matters. "Open" means our arguments pass through no confinement, so we would not know how to close it. "Controllable": we know how to open it in both modes (`copilot --allow-all-urls`, distinct from `--allow-all-tools`, which does not cover URLs). "Write mode only": the `codex` sandbox only exposes its network setting under `sandbox_workspace_write` — with `-s read-only`, the network is cut with no recourse.

This is the raison d'être of the `network` setting, available at three levels (policy, role, task) and tri-state:

```bash
caesar run --agent codex --mode write "install the missing dependency"   # auto: open, possible here
caesar run --agent codex --mode read-only --network on "…"               # refused, with the reason and the remedy
caesar run --agent codex --mode write --network off "…"                  # network explicitly cut
```

- `auto` (default) — opens the network wherever the chosen agent allows it; elsewhere, the task still launches and the report carries an `info` finding. This is what lets the `reviewer` and `investigator` roles, read-only on codex, keep running.
- `on` — **fails the delegation** if the agent cannot provide the network, before any launch and without leaving a task directory behind. Prefer it whenever the objective is impossible without the network: a clean refusal beats a sub-agent burning its budget on an install doomed to fail.
- `off` — closes it where possible. Where it is not, `caesar` says so rather than announcing a guarantee it does not have.

When — and only when — `caesar` knows the network is cut, it writes it into the agent's brief, to spare it wasting its turns on it.

A word on `claude`: it is in the catalog (delegating from one Claude Code instance to another makes sense — cross-review, for example), but the default policy refuses it (`allow_recursion: false`) precisely because it is the case most likely to loop. `caesar agents enable claude` or `caesar policy allow claude` lifts that refusal explicitly, if needed.

## Installation and first steps

pnpm monorepo, Node 24. Not yet published on npm: you use it from a checkout of the repository, targeting with `--root` the project where you want to delegate tasks.

```bash
pnpm install
pnpm exec tsc -b        # builds all packages

pnpm run caesar init   --root <path-to-your-project>   # creates <project>/.caesar/config.toml + the system prompts + deposits the skill and commands for detected runtimes
pnpm run caesar doctor --root <path-to-your-project>   # which agents are installed, with which capabilities, allowed or not
```

`pnpm run caesar <command>` is the `caesar` script in **this repository's root** `package.json` (`node packages/cli/dist/bin.js`): it runs from here, never from the target project itself — hence `--root <path-to-your-project>` to tell it where to act. Typed from a directory that is not a checkout of this repository, `pnpm run caesar …` fails immediately (`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`): this script exists only in this monorepo's root `package.json`, nowhere else.

`caesar doctor` inspects the catalog and cross-checks it against the effective policy. Real example, on a machine where all five agents are installed:

```
$ caesar doctor
▞▚ caesar · doctor ───────────────────────────────────────────────────────────────

╭─────────────┬─────────────────────────┬──────────────────────────┬───────────╮
│ agent       │ version                 │ capabilities             │ policy    │
├─────────────┼─────────────────────────┼──────────────────────────┼───────────┤
│ codex       │ codex-cli 0.147.0       │ net(w) ro schema msg re… │ allowed   │
│ antigravity │ 1.1.12                  │ net ro schema resume di… │ allowed   │
│ opencode    │ 1.18.16                 │ net resume model mcp     │ allowed   │
│ copilot     │ GitHub Copilot CLI 1.0… │ net± ro resume dirs mod… │ denied    │
│ claude      │ 2.1.227 (Claude Code)   │ net ro resume dirs mode… │ denied    │
╰─────────────┴─────────────────────────┴──────────────────────────┴───────────╯

DENIED BY POLICY
Intended state, unless you decide otherwise.
  - "copilot": Agent "copilot" denied: present in the policy's "denied" list.
    Allow it with "caesar agents enable copilot --global".
  - "claude": Agent "claude" denied: allow_recursion is disabled (delegating to
    Claude from Claude Code would be recursion). Enable "allow_recursion"
    (Policy tab of the "caesar config" TUI, or edit .caesar/config.toml — no
    dedicated subcommand today).
```

`allowed` reads there in green and `denied` in red: see "[The theme](#the-theme)" for what the color carries, and for what happens when it is not available. `--verbose` adds the binary's path and the capabilities spelled out in full.

`packages/cli/package.json` also declares a `caesar` binary (`bin: { caesar: "./dist/bin.js" }`): once published, or linked into your own projects by the usual pnpm means, `caesar <command>` works directly on the `PATH`, launched **from the target project** — no more `--root`, no more coming back to this repository; `resolveRoot` then walks up automatically to the first `.caesar/` or `.git/` found from the current directory. **This is the case the rest of this document assumes** (`caesar <command>`, typed from the target project); substitute `pnpm run caesar <command> --root <path-to-your-project>` if you are working from an unlinked checkout of this repository, as above.

Every command accepts `--root <dir>` (explicit project root; by default, automatic search for `.caesar/` or `.git/` walking up from the current directory). Most also accept `--json` (machine output, no color and no formatting) — two exceptions: `caesar mcp serve` does not know it at all (`unknown option`, that command must write nothing but the MCP protocol on stdout); `caesar config` refuses it explicitly (interactive TUI, there is no machine output to produce).

## Command-line usage

`caesar --help` is the map: the sixteen commands are grouped there by use — getting started, delegating, following, configuring, integrating — rather than listed in declaration order. `caesar <command> --help` gives the detail of a single one.

`caesar run` is the complete round-trip: delegates, waits, returns the report. Real example (Codex agent, isolation on a disposable worktree):

```
$ caesar run --agent codex --isolation worktree "Create a hello.txt file containing exactly OK"
▞▚ caesar · run ──────────────────────────────────────────────────────────────────

  ● start      agent "codex"
  ▸ tool       shell — wc -c hello.txt && od -An -t x1 hello.txt (started)
  » agent      I am creating the file with exactly two bytes, no trailing newline.
  ▸ tool       shell — wc -c hello.txt && od -An -t x1 hello.txt (succeeded)
  ~ file       created hello.txt

✓ Task t_680818a6 — status: succeeded (report "success" via "schema")
  The hello.txt file was created with exactly the two bytes "OK", no trailing newline.

Files modified (according to git)
  ~ created hello.txt

Isolated in a worktree: "caesar diff t_680818a6" to see the diff, "caesar apply t_680818a6" to integrate it.
```

The tool appears **as soon as it starts**, not only at its end, and what the agent says is displayed as it streams. The label is fixed-width so the texts line up: the column can be scanned at a glance, where variable-length bracketed prefixes forced you to read the start of every line.

Under `worktree` isolation, nothing touches the main repository until you have decided it should:

```
$ caesar diff t_680818a6a92047a2b08bb904e46d8427
diff --git a/hello.txt b/hello.txt
new file mode 100644
index 0000000..a0aba93
--- /dev/null
+++ b/hello.txt
@@ -0,0 +1 @@
+OK
\ No newline at end of file

$ caesar apply t_680818a6a92047a2b08bb904e46d8427
Task "t_680818a6a92047a2b08bb904e46d8427" applied to the main repository.
```

`caesar run` accepts `--role <name>` (picks the agent via a configured role and its fallback chain — see `caesar role list`) or `--agent <id>` (fixes the agent, wins over `--role`), `--mode read-only|write`, `--isolation inplace|worktree|auto`, `--timeout 10m`, `--model <id>`, `--context <text or @file>`, `--network auto|on|off` (see "Supported agents" above), and `--channel` (opens the bidirectional MCP return channel: the sub-agent can ask the main agent a question along the way rather than guess — see `docs/protocol.md`). At least one of `--agent`/`--role` is required.

What `caesar` does not expose goes after `--`, as is, at the end of the agent's command line:

```bash
caesar run --agent codex "…" -- --enable feature_x
```

The separator is mandatory: without it, a stray operand remains a typo and `caesar` refuses it rather than sending it to the agent. Deliberately absent from the `caesar_delegate` MCP tool — it is a gesture you type, not a latitude left to the orchestrator, which could otherwise escalate a sub-agent's privileges on its own.

## The workshop

A git worktree contains only **tracked** files. Installed dependencies, the `.env`, ignored directories carrying briefs or artifacts are not there: nothing installs there, nothing runs there, nothing can be verified there. On a real project, isolation became an empty space with nothing to do in it — and bypassing it with `--isolation inplace` remained the only practicable way out. That is how a sub-agent ended up writing directly onto the user's working branch.

The `[worktree]` section of `.caesar/config.toml` describes what must be brought along for the worktree to become a place to work:

```toml
[worktree]
copy  = ["node_modules", ".env"]   # copied — isolated from the workspace
link  = []                         # linked — shared, hence not isolated
setup = ["pnpm install --offline"] # run in the worktree, before the agent
```

`caesar init` fills it in from what it finds (`pnpm-lock.yaml`, `Cargo.toml`, `pyproject.toml`, `.env`…), and writes nothing if it finds nothing.

**`copy` rather than `link`.** On a copy-on-write filesystem — APFS, Btrfs, XFS — the copy is done by clone, and duplicates nothing until someone writes. Measured on a 975 MB `node_modules` (~100,000 files): **6.3 s and 11 MB of disk**, versus 15.0 s and 994 MB for an ordinary copy. So it is not free — the tree walk still has to happen — but it is the price of real isolation, and it compares to the cost of the `setup` it avoids re-running. The copy remains a true copy from the agent's point of view: two simultaneous tasks share nothing, and what one breaks at home breaks nothing elsewhere.

`link` exists for filesystems without copy-on-write, but shares the directory with the workspace — the task's report then says so in plain words.

What `caesar` itself put in place is removed from the diff: a copied `.env` appears neither in `caesar diff` nor in `caesar apply`. And a declared path that cannot be put in place — tracked by git, not ignored, absent — produces a finding naming the key to fix, rather than a task that fails with no visible reason.

### In-place writing is refused by default

A **write** task that requests `--isolation inplace` in a usable git repository is refused, naming the remedy. This is not an abstract precaution: it is the rule whose absence made it necessary. The refusal lands before any task directory is created.

If the worktree seems incomplete, the answer is `[worktree]`, never `inplace`. For repositories where the mixing is knowingly accepted, `allow_inplace_write = true` under `[policy]` lifts the ban — and two write tasks still cannot share the same tree at the same time, their diffs would become unattributable.

Outside a git repository, or in a repository without a single commit, no worktree is possible: `inplace` remains the only mode of operation there, and nothing is refused.

## Simultaneous tasks

Several agents run at once, each in its own workshop (`.caesar/wt/<taskId>`, on a branch named to be read — `caesar/<role>/<objective>-<8 chars>`). This is the normal mode from Claude Code: `caesar_delegate` hands back immediately with a `task_id`, you launch several, `caesar_await` collects the results.

`policy.max_parallel` (4 by default) caps the whole — **across processes included**. Six `caesar run` in six terminals, plus a Claude Code conversation that delegates: all share the same slots, materialized as files under `.caesar/state/slots/`. A `caesar run` that finds no room waits while saying so, and names who is occupying:

```
$ caesar run --agent codex "…"
1 task(s) already running under this project (max_parallel = 1) — waiting for a slot. Ctrl-C to give up.
  · pid 51820 — caesar run — review the parser (since 2026-08-11T13:42:11.004Z)
```

A killed process (`kill -9`) leaves its slot file behind: the first caller that finds everything occupied checks each holder and reclaims those whose process no longer exists. A limit that could become a permanent deadlock would be worse than no limit at all.

It also leaves its task hanging. A task's status is written by the process conducting it: killed — `kill -9`, MCP session closed, machine shut down — it never writes it, and the record stays "running" indefinitely. `caesar ps` and `caesar gc` reconcile that state: a task whose marker names a vanished process moves to failed, with a report that says what happened, and the worktree it was holding becomes collectable again. The proof is positive — a pid that can no longer be found — never deduced from an absence: a task without a marker is never concluded by default, and `caesar cancel <id>` remains the manual way out.

Two caveats to know. The wait is a poll, not a queue: between two candidates, entry order is not guaranteed. And reclaiming a dead slot relies on the pid, which only makes sense on a single machine — a `.caesar/` on a network share, used from two workstations, would see the other's slots as alive indefinitely.

## Watching the sub-agents work

A delegated task is not a black box: `caesar watch` opens a window onto what is happening, next to the conversation or terminal that launched the delegation.

```bash
caesar watch                 # all running tasks, redrawn frame
caesar watch t_a1b2 t_c3d4   # only these
caesar watch --once          # one frame, then exit
caesar watch --json          # NDJSON of the events, several tasks merged
```

```
▞▚ caesar · watch   1 active · max_parallel 4                             17:21:20

● t_efb5914d codex        —            25s  inplace · write
  Write three files a.txt, b.txt and c.txt, then run 'sleep 8 && ls -1'…
  ▸ shell /bin/zsh -lc 'sleep 8 && ls -1' — 3s
  ~ 3 file(s)  ·  11 event(s)

q or Ctrl-C to quit — watching modifies nothing.
```

No daemon is needed: the engine writes `events.jsonl` **during** execution and publishes task state through atomic writes. `caesar watch` only reads what another process writes — the same property that makes `caesar cancel` and the sharing of `max_parallel` work.

Four things there are deliberate:

- **A tool appears as soon as it starts**, not at its completion. That is the whole difference between seeing a three-minute `npm install` set off and discovering it at minute three.
- **Silence is displayed.** A stuck task and a working task are indistinguishable without it; past thirty seconds without a single event, the view says so.
- **A pending question jumps ahead of everything else.** A sub-agent waiting for an answer over the return channel looks exactly like a frozen sub-agent.
- **Finished tasks stay visible** for a few minutes, with their report status: a task that disappears the moment it finishes is a task whose ending you will never know.

Outside a terminal (redirection, `| tee`, script), no redraw and no ANSI sequences: one line per event, and `--json` yields usable NDJSON.

What each agent lets you see depends on what its CLI narrates, and that varies a lot:

| Agent | During execution |
|---|---|
| `codex` | start **and** end of every command, modified files, its progress reports |
| `claude` | tools, results, text, and an in-progress thinking signal |
| `opencode` | tools (only once finished — its stream does not announce their start), text |
| `antigravity` | its text as it streams, its errors; its tool calls are not yet translated |
| `copilot` | text, session errors; its tool calls remain unverified for lack of available quota |

These translations are written from real captures, kept in `packages/core/test/fixtures/` and replayed by the tests. Where a shape could not be observed, the adapter says so in plain words rather than guessing — a branch written from a plausible convention had left opencode's tool calls invisible for months, while staying green.

The other subcommands: `caesar ps` (running and recent tasks), `caesar logs <id> [--raw] [--follow]`, `caesar cancel <id>`, `caesar agents list|enable|disable|test` (`test` launches a real read-only micro-task to verify that an agent responds — `--yes` mandatory, it consumes its quota), `caesar policy show|allow|deny`, `caesar role list|show|add|remove`, `caesar protocol schema <task|report|event> [--strict]` (publishes the standard as JSON Schema). The ones that modify (`policy allow|deny`, `agents enable|disable`, `role add|remove`) accept `--global`/`--local` to target a layer other than the project — see "Layered configuration" below.

## Using from Claude Code

Register the MCP server with Claude Code:

```bash
caesar mcp install claude --root <your-project>
# runs: claude mcp add caesar -- caesar mcp serve --root <your-project>
```

`caesar mcp install` also works with `codex`, `copilot`, `opencode` and `antigravity` (installation via native subcommand for `claude`/`codex`, via merged configuration file for the other three — `--dry-run` shows what would be done without executing or writing anything). Once registered, Claude Code exposes ten tools prefixed `mcp__caesar__` (`caesar_delegate`, `caesar_await`, `caesar_status`, `caesar_logs`, `caesar_cancel`, `caesar_diff`, `caesar_apply`, `caesar_list_agents`, `caesar_list_roles`, `caesar_answer`) — the detail of each is in `packages/mcp-server/src/tools/*.ts`.

What makes a delegation as natural as invoking a native sub-agent is not these tools taken in isolation: it is the `caesar` skill, deposited by `caesar init` with the main agent, which teaches it how to use them.

### The agentic knowledge: skill and commands

**Direct, don't execute.** The skill teaches the main agent — Claude Code, Codex, Copilot CLI, OpenCode or Antigravity CLI — to brief an external executor for a precise task, to launch several at once without waiting for one to start the next, and to never take what comes back at its word: the diff decides, not the sub-agent's summary. Five commands follow directly from it, one per gesture: `/caesar-delegate` (one implementation, one provider), `/caesar-fanout` (several independent objectives, in parallel), `/caesar-race` (the same objective on several providers, compared side by side), `/caesar-review` (a read-only review by a provider that did not write the diff), `/caesar-tasks` (the state of what is delegated). In a runtime where the skill is deposited, asking is enough: *"delegate the implementation of X to Codex"* — it then guides the main agent itself through the `caesar_delegate` → `caesar_await` → report-and-diff presentation sequence, without blocking the conversation while the external agent runs; under Claude Code, the commands give the same sequence explicitly, without depending on the skill's automatic triggering.

**Where it installs** — a single place governs this table, `packages/core/src/agent-assets.ts`, verified against each real binary:

| Target | Skill | Commands |
|---|---|---|
| shared (`codex`, `copilot`, `antigravity`) | `.agents/skills/caesar/` | — |
| `claude` | `.claude/skills/caesar/` (dedicated copy) | `.claude/commands/` (`caesar-*.md`) |
| `opencode` | `.agents/skills/caesar/` (shared) | `.opencode/commands/` (`caesar-*.md`) |

Two copies rather than one: Claude Code does not read `.agents/skills/` — verified empirically on the binary, not assumed from its documentation — a skill placed only there would remain invisible to it.

**How.** `caesar init` detects the runtimes present on the `PATH` and deposits (or refreshes) the skill and the commands for them; if none is detected and no `--agent` is given, the shared base (`.agents/skills/caesar/`) is deposited anyway, ready for the first runtime installed afterwards. `--agent <id>`, repeatable, forces the list of targets instead of detection; `--no-skills` cuts this deposit entirely (not remembered, to be passed again on each `init`). On an already-initialized project, re-running `caesar init` **without** `--force` is a refresh: `.caesar/config.toml` and `.caesar/roles/*.md` stay intact, they are the files the user edits — the skill and the commands, entirely derived from the catalog and thus belonging to no one, are rewritten from it. This is precisely what lets an improved skill reach an already-initialized project: a simple `caesar init`, nothing else to reinitialize. On the `claude` side, `caesar init` also merges `<project>/.claude/settings.json`: the six MCP tools that modify none of the user's files (`caesar_list_agents`, `caesar_list_roles`, `caesar_status`, `caesar_await`, `caesar_logs`, `caesar_diff`) are added to `permissions.allow` if they are not already there, without touching the rest of the file. In every case, the skill does nothing but call the tools of the `caesar` MCP server: they only exist for a runtime once `caesar mcp install <client>` has been run for it (see above).

**For contributors.** The sources of the skill and the commands live in the clear in `.claude/skills/caesar/` (+ 4 references) and `.claude/commands/` — the Claude Code format serves as the source, the other runtimes receive an adaptation of it. `pnpm run assets:sync` regenerates the embedded catalog (`packages/core/src/agent-assets.generated.ts`) from these files, and a drift test fails if either was edited without re-running the other: the sources and the catalog cannot diverge in silence. The repository otherwise keeps its three Claude Code sub-agents (`.claude/agents/`) for its own development — they are not deposited with the user and are not part of this catalog. Careful when editing these sources: they are exactly the paths that `caesar init` deposits/refreshes for the `claude` target in this very repository — running `caesar init` while you are modifying them overwrites your edits not yet synchronized into the catalog. Run `pnpm run assets:sync` first, or pass `caesar init --no-skills` for the duration of the edit.

## Layered configuration: global, project, local

Three levels, from the most general to the most specific — the most specific wins, field by field:

| Level | File | Versioned |
|---|---|---|
| global | `~/.config/caesar/config.toml` | no — per machine |
| project | `<project>/.caesar/config.toml` | yes, shared with the team |
| local | `<project>/.caesar/config.local.toml` | no — per machine (see `.gitignore` below) |

Setting your policy, roles and agents once in the global layer means every new project inherits them without doing anything:

```bash
caesar init --global                 # creates ~/.config/caesar/config.toml + deposits skill and commands at global scope
caesar policy deny copilot --global  # now applies to every project on this machine
```

The commands that modify — `caesar policy allow|deny`, `caesar agents enable|disable`, `caesar role add|remove` — accept `--global`/`--local` to target a layer other than the project (the default, with no option). Mutually exclusive: `caesar` explicitly refuses `--global` and `--local` together rather than letting the last one read win in silence. Each write touches **only** the targeted layer, and that file contains only what that layer declares in its own right — never the merge: a configuration read by `caesar` (including `caesar policy show`) always adds up the three layers, but writing never writes that merged result back into a single one of them. That is precisely what was missing before: a single `caesar policy deny copilot` used to copy the effective configuration (defaults included) into the project's file, freezing `max_parallel` and everything else along the way — modifying the global file afterwards then had no effect at all on that project.

**Modifying a list (`allowed`/`denied`) materializes that list in the targeted layer.** These two lists merge by replacement, not by union: a layer that declares them entirely replaces those of less specific layers. `caesar policy deny X` therefore writes the **effective** list (the one `caesar policy show` displays) augmented with `X`, never `X` alone — otherwise the command would silently erase what the global layer had already placed there. When the targeted layer did not yet declare that field, `caesar` says so: it now takes ownership of it, and modifying a less specific layer afterwards will no longer have any effect on it.

```
$ caesar policy deny copilot --global
$ caesar init
$ caesar policy deny opencode
Agent "opencode" added to the "denied" list (project layer (.caesar/config.toml)).
Warning: the "denied" list was not declared by the project layer (.caesar/config.toml); it now takes ownership of it with the current effective value (copilot, opencode) — modifying a less specific layer (global or default) will no longer affect this field here.
```

At the end of this scenario, `.caesar/config.toml` contains **only** `denied = ["copilot", "opencode"]` — no copied defaults, no frozen global setting; modifying `max_parallel` in the global file afterwards keeps propagating to this project. `caesar policy show` indicates the provenance of each value (`global`, `project`, `local`, or `default`), and `caesar role show`/`caesar agents list` extend it to roles and agents.

`caesar init` creates the **project** layer: the default system prompts (`.caesar/roles/*.md`), the deposit of the skill and the commands for detected runtimes (see "[Using from Claude Code](#using-from-claude-code)" above), and completes the project's `.gitignore` with `.caesar/config.local.toml`, `.caesar/tasks/`, `.caesar/wt/` and `.caesar/state/` (adds only the missing lines, never rewrites the file from scratch; does nothing, while saying so, if the directory is not a git repository). `caesar init --global` creates the **global** layer, entirely from the default settings. Without `--force`, re-running either on an already-initialized layer is no longer a refusal: the command succeeds (code 0), leaves `config.toml` and the roles intact, and merely refreshes the skill and the commands — `--force` reinitializes everything from scratch, system prompts included.

## The theme

A single palette for the command line **and** for the TUI, in `packages/theme`: it used to live in the TUI alone, while the CLI picked its colors case by case among seven basic ANSI codes — the two halves of the same tool did not look alike on screen.

Two rules hold it, and they explain most of what you see:

- **Primary text never carries color.** It inherits the terminal's foreground, so it stays readable on light and dark backgrounds alike. Only the secondary, the tertiary and the semantic (`allowed` / `denied`, task statuses, report statuses) are colored. That is why a sub-agent's words, in `caesar run`, come out as neutral text: it is its badge that is tinted, not what it says.
- **Color classifies, it does not decorate.** A colored value is a value your eye goes looking for without reading it.

### The three channels

| | Structure (frames, banners) | Color |
|---|---|---|
| `--json` | no | no |
| Outside a terminal (pipe, redirection, `\| tee`) | yes | no |
| Terminal | yes | yes |

`--json` stays strictly JSON: no ANSI sequence, no banner, nothing else on `stdout`. It is the channel through which an agent consumes this CLI, and it does not move. A framed table, on the other hand, cuts up poorly under `grep`/`awk` — that is accepted, `--json` is made for that.

### What adapts on its own

- **Color depth**: truecolor if `COLORTERM` announces it, otherwise the 256 if `TERM` contains `256color`, otherwise the basic 16. Deliberately conservative: a 256 sequence emitted toward a terminal that ignores it displays in the clear in the middle of the text.
- **[`NO_COLOR`](https://no-color.org)** and `TERM=dumb` cut all color.
- **Non-UTF-8 locale** (`LC_ALL=C`): fine rules and marks fall back on an ASCII set of the same width — `+--+`, `|`, `*`, `+`, `x`. Without this fallback, a Unicode frame on a terminal that cannot read it is less readable than a table without a frame.
- **Terminal width**: the frame's cost (`3N+1` characters for N columns) enters the budget, so that no border ever wraps. When the frame can no longer fit, it is abandoned in favor of an aligned layout, which recovers the space it cost.

## Configuration interface

`caesar config` launches a TUI (OpenTUI) to edit policy, roles and MCP integrations interactively. It has one requirement of its own: **it runs under Bun**, not Node — OpenTUI renders through Bun's FFI, unavailable on Node 24. Without `bun` on the `PATH`, `caesar config` explains the situation and points to the equivalent subcommands rather than failing dryly:

```
$ caesar config
The configuration TUI requires Bun: OpenTUI renders through its FFI, which Node 24 does not allow […]. "bun" was not found in the PATH.
Install Bun (https://bun.sh), or use the equivalent subcommands:
  - caesar policy show   Effective policy (allow/deny, provenance).
  - caesar role list     Roles, fallback agents, the agent picked today.
  - caesar agents list   Agent catalog: presence, capabilities, authorization.
```

`@caesar/core` remains in every case the single source of truth for the configuration — the three layers above, merged: the TUI, these subcommands and the MCP server are different facades over it, none re-reads or rewrites it on its own account.

## Standalone executable

`caesar` also builds into a single binary, with no Node, no Bun, no `node_modules` required on the target machine: `bun build --compile` embeds the Bun runtime, the CLI and the TUI (OpenTUI and its native core included) into a single file.

```bash
pnpm run build:binary   # equivalent to scripts/build-binary.sh — builds dist-bin/caesar
```

Produces `dist-bin/caesar` (directory ignored by git; ~70 MB, Bun and OpenTUI embedded). Usable directly, without installation:

```bash
dist-bin/caesar doctor
dist-bin/caesar mcp serve --root <project>
dist-bin/caesar config --root <project>
```

This binary embeds Bun: the project's initial trade-off ("Node everywhere, Bun for the TUI alone", justified by the MCP server having to run without Bun) no longer applies to it — `caesar config` there mounts the TUI directly in the current process rather than looking for an external `bun`, and `caesar run --channel` self-invokes (`caesar channel serve --task-dir <dir>`, an internal subcommand hidden from the help) rather than resolving `@caesar/mcp-channel` through `node_modules`, absent from a compiled binary. The Node path described in the rest of this document (`pnpm run caesar`, `pnpm exec tsc -b`) remains the everyday development path in this monorepo, and keeps working identically — these two behaviors only activate in the binary, never under Node.

**Cross-compilation** (`--target=bun-linux-x64` and friends, via `scripts/build-binary.sh --target=bun-linux-x64`): fails today — OpenTUI depends on a package of per-platform native binaries (`@opentui/core-<platform>`), of which pnpm installs only the current machine's. Producing a binary for another platform means re-running the pnpm install on that platform (or in an environment targeting it) before compiling.

## Plugging in an agent outside the catalog

A CLI that is not in the catalog of five is declared in `.caesar/config.toml`, without writing code — the generic adapter (`packages/core/src/registry/generic.ts`) builds its command line from a template:

```toml
[[agent]]
id = "my-agent"
bin = "my-agent-cli"
args = ["--task-file", "{{taskDir}}/task.json", "--out", "{{reportPath}}", "--cwd", "{{workspace}}", "{{prompt}}"]
cwd_mode = "process"      # "process": the workspace is the process's cwd. "flag": already carried by a token in args.
network_args = ["--online"]  # optional: what must be added to open the network.
```

Declaring `network_args` is asserting that **without** these arguments the CLI is confined: `caesar` then promotes its network capability from "unknown" to "controllable", and honors them according to the task's `network` setting. Without them, `caesar doctor` announces "network unknown" and promises nothing — neither opening nor closing.

The tokens `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}` and `{{model}}` are substituted; a token with no value (`{{model}}` if no `--model` was requested, for example) makes the entire argument disappear rather than leaving a residual `undefined`. A generic agent has by default no declared capability (`mcpInjection: "none"`, no native output schema and no MCP channel): it settles for the most tolerant report tier, the one that only requires knowing how to read `$CAESAR_TASK_FILE` and write `$CAESAR_REPORT_PATH` — see `docs/protocol.md`. That is deliberate: the standard's minimal contract is designed to be reachable by a script of a few lines, not only by the five agents supported by name.

## The standard

The contract that lets any agent — supported by name or generic — receive a mission and return a usable report is documented independently of this repository in [`docs/protocol.md`](docs/protocol.md): the task directory, the environment variables, the shape of `task.json`/`report.json`/`events.jsonl`, the four report-recovery tiers, and the optional MCP return channel.

## Migrating from "orch"

This project was previously called `orch` (repository `agent-orchestrateur`). The rename to `caesar` is a clean break: nothing the old name put in place is read or migrated. Concretely, on a machine or a project that used `orch`:

- the projects' `.orch/` directories (state, worktrees, config) and the global config `~/.config/orch/` are ignored — redo `caesar init` in each project and `caesar init --global`, then delete the old directories by hand;
- the `orch/*` branches and worktrees still present are no longer recognized by the GC — clean them up with `git worktree remove` / `git branch -D`;
- the `orch` MCP registrations with the clients remain orphaned — remove them (`claude mcp remove orch`, `codex mcp remove orch`, edit the Copilot/Antigravity/OpenCode config) then re-register with `caesar mcp install <client>`;
- the assets deposited under the old name (`.claude/skills/orch/`, `.claude/commands/orch-*.md`, `.agents/skills/orch/`) become obsolete — `caesar init` deposits the new ones, the old ones are to be deleted by hand.
