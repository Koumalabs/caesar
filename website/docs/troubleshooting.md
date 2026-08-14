---
title: Troubleshooting
sidebar_position: 6
description: Eleven symptom, cause and remedy entries for the refusals and findings you are most likely to run into.
---

{/* Source: .claude/skills/caesar/references/troubleshooting.md — manual resync */}

# Troubleshooting

Most of what you will run into here is a refusal or a finding that already names its own fix in its own message — read it before working around it. Each entry below states the symptom as it appears, its cause, and the remedy.

### `inplace` refused for a write task

**Symptom.** Nothing runs — the delegation is refused up front. The message names `inplace` as the isolation in play (whether it was asked for directly or inherited from a role or the policy default), points at the repository it is protecting, and suggests what to do instead.

**Cause.** Running a write task `inplace` means writing straight onto the current branch of the working tree, where its edits would blend with the user's own and with any other task's, past the point where a diff could untangle who did what. The refusal only fires when every one of four conditions holds together: `inplace` was requested, the task writes, the repository is a usable git one, and `allow_inplace_write` was not opted into. Drop any single one and there is nothing to refuse — a read-only `inplace` task (how the shipped `reviewer` role runs by default) is unaffected, and so is a write task in a workspace that cannot offer a worktree at all.

**Remedy.** Keep isolation at `worktree` or `auto`. When the worktree itself turns out unusable because untracked files are missing, the fix is declaring them under `[worktree]` — covered in the next entry — not switching isolation. `[policy] allow_inplace_write = true` exists for repositories that accept the mixing on purpose; it does not paper over an incomplete worktree.

See [The workshop: worktrees](./guides/worktrees.md) for why isolation defaults this way.

### The worktree looks empty; nothing installs or runs there

**Symptom.** Either a low-severity finding — something like *worktree without a workshop* — listing the paths the project seems to need, or a task that fails without an obvious reason, its own report blaming a missing dependency.

**Cause.** Only tracked files make it into a git worktree. `node_modules`, `.venv`, `target`, `.env`, and any other ignored directory simply are not there.

**Remedy.** List the missing paths under `[worktree] copy` in `.caesar/config.toml` (add the install command to `setup` too), or let `caesar init --force` detect them for you. Switching to `inplace` is never the answer.

Three related findings are worth recognizing on sight: a `[worktree]` path that cannot be placed names one of four reasons (absent, tracked by git, neither tracked nor ignored, or already present) plus the key to fix; a path placed via `link` gets an informational note instead, since sharing the directory with the workspace means it is not truly isolated; and a warning about `.caesar/wt/` missing from `.gitignore` means that file was rewritten without it — harmless, and `caesar init --force` puts the line back.

### The diff is empty although the agent says it wrote files

**Symptom.** The report insists files were changed, yet `caesar_diff` comes back `is_empty: true` with no patch.

**Causes, in order of likelihood.**

1. **No worktree exists to diff — the task ran `inplace`.** By construction there is nothing to compare against; whatever changed is sitting in the working tree itself. The task's recorded status shows which isolation actually applied, and it is not always the one requested: a provider with no native read-only mode gets forced into a worktree even for a read-only task, and a worktree gets declined outright when git cannot supply one.
2. **The changed paths belong to the orchestrator, not the agent.** Anything materialized from `[worktree] copy`/`link` is stripped from the diff, prefix and all — an edit made inside `node_modules`, say, simply will not show up.
3. **Nothing was actually written.** The file list in the report is only the sub-agent's own claim; the diff records what really happened. Inside a git repository the two get compared, and any mismatch turns into a finding worth reading.

Committing inside the worktree does not, on its own, explain an empty diff: the comparison is always against the commit frozen when the worktree was created, never against `HEAD`, so committed or not, the result is identical.

### The agent is refused

**Symptom.** Instead of a task id, the delegation call comes back with an error that names both the agent and the rule that stopped it.

**Cause and remedy.** Four rules are checked, in a fixed order, and each has its own fix — see [Configuration](./reference/configuration.md#the-four-refusal-rules) for the complete table. `denied` clears with `caesar agents enable <id>`; an `allowlist` miss clears with `caesar policy allow <id>`; `recursion` — the default block on `claude` — only lifts once `allow_recursion` is set by hand; `depth` has nothing to do with the agent at all, it means the delegation chain has already reached `max_depth`.

**Target the right layer.** Run `caesar policy show` to see where each value actually comes from. Writing to the project layer will not lift a refusal declared globally — it would instead copy the effective, still-refusing list down into the project file. Point `--global` or `--local` at whichever layer actually declares the rule.

### Network not guaranteed

**Symptom.** An informational finding called *network not guaranteed*, or a `network_warning` field riding along on the delegation result.

**Causes.** Three different situations produce it, and the wording tells them apart:

- the provider only opens the network in write mode — `codex`'s sandbox cuts it off in read-only mode with no way around that; under `auto`, the task simply proceeds without network;
- closing the network was requested, but caesar has no known way to close it for that particular provider, so it says so rather than claim a closure that never happened;
- the network was required (`on`) on a provider whose confinement caesar cannot verify — declaring `network_args` for that agent is what teaches it how to open the network deliberately.

**Remedy.** When the objective truly cannot proceed offline, request `network: "on"` explicitly: the delegation then refuses outright before it even starts, instead of spending its whole budget on an install that was never going to work. When it can proceed offline, setting `network = "off"` on the role states that intent plainly and the warning stops appearing.

### A task stays `running` forever after a `kill -9`

**Symptom.** `caesar ps` never stops calling a task `running`; `caesar watch` follows it forever; its worktree sits there, never collected.

**Cause.** Writing a task's final status is the job of the process running it, done as part of its own cleanup. A process killed outright — `kill -9`, a session closed mid-run, a machine going down — never reaches that step, so the record stays stuck at `running` indefinitely, and a worktree attached to a `running` task is exempt from collection.

**Remedy.** Reading a task's state triggers a sweep first, automatically: `caesar ps` and the status/await tools all check for abandoned tasks before answering. Once a task's recorded process can no longer be found, it gets marked `failed` (with a report explaining what happened) and its worktree is freed for collection; `caesar gc` runs the same sweep before it collects. This only ever fires on positive proof — a pid that has genuinely vanished — never on a mere absence of activity, so a task with no process marker at all stays untouched by it. `caesar cancel <id>` is still there for the manual case.

### Waiting for a `max_parallel` slot

**Symptom.** The delegation just does not start; `caesar run` prints how many tasks are already running, the current limit, and who is holding each slot.

**Cause.** `policy.max_parallel` — 4 unless configured otherwise — is not a per-process limit but a shared one, enforced through slot files under `.caesar/state/slots/` that every delegation against the same project root draws from.

**Remedy.** Wait it out, shrink the batch to fit under the limit, or raise `max_parallel` at whichever layer makes sense. A process that gets killed leaves its slot file orphaned, but that is not a permanent jam: the next caller to find every slot taken checks each holder in turn and reclaims any whose process is actually gone.

### `workspace_warning` on a delegation

**Symptom.** The delegation still succeeds, but a warning comes with it: the root caesar is delegating against does not match the repository the current directory belongs to.

**Cause.** `--root` gets fixed once, at MCP registration time. Move the working directory to a different repository — or a different worktree — afterward, and sub-agents keep working in a tree that nothing is watching anymore.

**Remedy.** Register again from the repository actually intended (`caesar mcp install`), or start the server pointed at it directly (`caesar mcp serve --root <repo>`). This stays a warning rather than a refusal, since the server's own current directory proves nothing about intent and blocking the delegation over it would cost more than it protects — but it is not one to shrug off either: a diff produced in the wrong tree is a diff that will never get found.

### `status: succeeded` with a report that says `failed`

**Symptom.** The process side of the task reads `succeeded`, but the report it produced says `failed`, `partial`, or `blocked`.

**Cause.** These track two separate things on purpose, and caesar never collapses them into one: the process status only says the CLI exited without error, while the report status is the sub-agent's own judgment of whether it actually accomplished the mission. A sub-agent that exits `0` after writing `{"status":"failed"}` is exactly this case.

**Remedy.** Look at both before drawing a conclusion — the report status is what judges the mission, the diff is the record of what actually happened. `caesar run` itself already requires both to agree before it returns exit code `0`.

### `npx caesar` fails: could not determine executable to run

**Symptom.** Every `npx caesar …` call fails right away with npm's own `could not determine executable to run`.

**Cause.** `npx` looks for something under `node_modules/.bin`, and there is nothing there to find: `caesar` lives on the PATH as a standalone binary, never as an npm dependency of any project.

**Remedy.** Invoke `caesar` on its own. `command -v caesar` shows where the binary sits; `caesar doctor` confirms what it can reach from there. An empty result from the shell points at a missing installation, not at anything wrong with the project's `package.json`.

### `caesar gc` keeps a worktree whose diff was already applied

**Symptom.** `caesar gc` keeps a finished task's worktree around — "unintegrated changes", or "modified since its application" — even though the work is clearly already in the workspace.

**Cause.** Three things can explain it: the diff reached the workspace some other way than `caesar apply` (a manual copy, a hand re-implementation), so there was never an application to record and gc has no way to infer one from content alone; or the worktree kept changing after `caesar apply` ran, and it is exactly that later change gc is protecting; or the application happened under an older version of caesar, before this tracking existed.

**Remedy.** `caesar diff <id>` shows exactly what the worktree is still holding. If it belongs in the workspace, re-run `caesar apply <id>`; once settled — or once the work is known to be integrated by other means — `caesar gc --force` clears out what gc could not confirm on its own.

## Next steps

- [Configuration](./reference/configuration.md) — the policy rules and worktree settings most of these entries point back to.
- [CLI reference](./reference/cli.md) — the exact flags for `gc`, `ps`, `diff`, `apply`, `cancel`.
