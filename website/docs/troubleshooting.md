---
title: Troubleshooting
sidebar_position: 6
description: Eleven symptom, cause and remedy entries for the refusals and findings you are most likely to run into.
---

{/* Source: .claude/skills/caesar/references/troubleshooting.md — manual resync */}

# Troubleshooting

Most of what you will run into here is a refusal or a finding that already names its own fix in its own message — read it before working around it. Each entry below states the symptom as it appears, its cause, and the remedy.

### `inplace` refused for a write task

**Symptom.** The delegation fails before anything runs. The refusal says isolation `inplace` was requested — explicitly, or inherited from a role or from the policy default — for a write task, names the repository being protected, and offers a remedy.

**Cause.** A write task run `inplace` would write straight into the working tree, on the current branch: its changes would mix with the user's and with those of other tasks, beyond what a diff can attribute. The refusal fires if and only if all four hold at once: `inplace` requested, write mode, a usable git repository, and no `allow_inplace_write` opt-in. Any one of them absent means no refusal — a read-only task `inplace` (the shipped `reviewer` role's default) is fine, and so is a write task in a workspace where no worktree is possible at all.

**Remedy.** Leave isolation on `worktree` or `auto`. If the worktree turns out unusable because untracked files are missing, declare them under `[worktree]` — see the next entry. `allow_inplace_write = true` under `[policy]` exists for repositories where the mixing is accepted knowingly; it is not the fix for an incomplete worktree.

See [The workshop: worktrees](./guides/worktrees.md) for why isolation defaults this way.

### The worktree looks empty; nothing installs or runs there

**Symptom.** A low-severity finding titled along the lines of *worktree without a workshop*, listing the paths the project appears to need — or a task that fails for no visible reason, with the sub-agent reporting a missing dependency.

**Cause.** A git worktree contains only tracked files: `node_modules`, `.venv`, `target`, `.env` and every ignored directory are simply absent from it.

**Remedy.** Declare them under `[worktree] copy` (and `setup` for the install command) in `.caesar/config.toml`, or re-run `caesar init --force`, which detects them. Never fall back to `inplace`.

A path declared under `[worktree]` that cannot be placed produces a finding naming which of four reasons applies (absent, tracked by git, neither tracked nor ignored, already present) and the key to fix. A path placed with `link` produces an informational finding instead: it is shared with the workspace, so it is not isolated. Separately, a finding about `.caesar/wt/` not being ignored by git means the project's `.gitignore` was rewritten without that line — not fatal, but `caesar init --force` restores it.

### The diff is empty although the agent says it wrote files

**Symptom.** `caesar_diff` returns `is_empty: true` with no patch, while the report claims files were changed.

**Causes, in order of likelihood.**

1. **The task ran `inplace`, not in a worktree.** There is no worktree to diff, so the diff is empty by construction — the changes are in the working tree itself. Check the isolation actually used: the task's status reports it, and it can differ from what was requested — a read-only task on a provider with no native read-only mode is forced into a worktree, and a worktree can be declined when git cannot provide one.
2. **The paths are ones the orchestrator itself placed.** Everything materialized from `[worktree] copy`/`link` is excluded from the diff, with prefix semantics. If the sub-agent edited something inside `node_modules`, it will not appear.
3. **The agent did not actually write anything.** The declared file list is only the agent's own claim; the diff is what actually happened. Inside a git repository the two are reconciled and any discrepancy is added as a finding — read the findings.

An agent that *commits* inside its worktree is not a cause by itself: the diff is taken against the base commit frozen at creation, never against `HEAD`, so the result is the same whether it committed or not.

### The agent is refused

**Symptom.** The delegation returns an error naming the agent and the rule applied, instead of a task id.

**Cause and remedy.** One of four rules, checked in order — see [Configuration](./reference/configuration.md#the-four-refusal-rules) for the full table. In short: `denied` needs `caesar agents enable <id>`; an `allowlist` refusal needs `caesar policy allow <id>`; `recursion` (the default refusal of `claude`) needs `allow_recursion` set by hand; `depth` is not about the agent at all — the delegation chain is already `max_depth` deep.

**Target the right layer.** `caesar policy show` reports the provenance of each value. A refusal declared by the global layer is not lifted by writing to the project layer — that write would materialize the effective list there, refusal included. Use `--global` or `--local` to match the layer that actually declares the rule.

### Network not guaranteed

**Symptom.** An informational finding titled *network not guaranteed*, or a `network_warning` on the delegation result.

**Causes.** Three distinct ones, and the wording distinguishes them:

- the provider can only open the network in write mode — `codex`, whose sandbox cuts it in read-only mode with no recourse; under `auto` the task runs anyway, without network;
- the network was asked to be closed and the orchestrator does not know how to close it for that provider — it says so instead of promising a closure that did not happen;
- the network was demanded (`on`) on a provider whose confinement the orchestrator does not control — declare `network_args` on that agent so it knows how to open it explicitly.

**Remedy.** If the objective genuinely needs the network, pass `network: "on"` — the delegation then fails outright, before launch, rather than burning a budget on an install that cannot succeed. If it does not, declaring `network = "off"` on the role makes the intent explicit and silences the warning.

### A task stays `running` forever after a `kill -9`

**Symptom.** `caesar ps` keeps showing a task as running; `caesar watch` follows it endlessly; its worktree is never collected.

**Cause.** A task's final status is written by the process conducting it, in its own cleanup path. Killed outright — `kill -9`, a closed session, a halted machine — it never gets to write it, and the record stays `running` forever; a running task's worktree is protected from collection.

**Remedy.** Reconciliation is automatic on read: `caesar ps` and the status/wait tools sweep abandoned tasks first. A task whose marker names a process that no longer exists is marked `failed`, with a report saying what happened, and its worktree becomes collectable. `caesar gc` does the same sweep and then collects. The proof is always positive — a pid that can no longer be found — never inferred from an absence: a task with no marker at all is never concluded on its own. `caesar cancel <id>` remains the manual exit.

### Waiting for a `max_parallel` slot

**Symptom.** A delegation that does not start; `caesar run` prints how many tasks are already in flight, the limit, and who holds each slot.

**Cause.** `policy.max_parallel` (4 by default) is enforced across processes, through slot files under `.caesar/state/slots/`. Everything delegating under the same project root shares them.

**Remedy.** Wait, cut the batch down to the limit, or raise `max_parallel` in the layer that suits. A killed process leaves its slot file behind, but the first caller that finds everything taken checks each holder and reclaims the ones whose process is gone — a stale slot is not a permanent block.

### `workspace_warning` on a delegation

**Symptom.** The delegation succeeds and carries a warning saying the orchestrator delegates on one root while the current directory belongs to a different repository.

**Cause.** The MCP registration freezes `--root` once and for all. If the working directory has since moved to another repository (or another worktree), sub-agents work in a tree nobody is looking at.

**Remedy.** Re-run `caesar mcp install` from the intended repository, or serve with `caesar mcp serve --root <repo>`. It is a warning rather than a refusal — the server's current directory is not proof of intent, and failing the delegation on that basis would cost more than it saves. But do not ignore it: a diff produced in the wrong tree is a diff nobody will find.

### `status: succeeded` with a report that says `failed`

**Symptom.** The task's process status is `succeeded` while the report's own status is `failed`, `partial` or `blocked`.

**Cause.** They are two different facts, deliberately not merged: the process status says the CLI exited cleanly; the report status is the sub-agent's own verdict on its mission. A sub-agent that writes `{"status":"failed"}` and still exits `0` produces exactly this.

**Remedy.** Check both before concluding anything: the report status is the verdict on the mission, the diff is the record of what happened. `caesar run` already crosses the two before returning exit code `0`.

### `npx caesar` fails: could not determine executable to run

**Symptom.** Any `npx caesar …` invocation fails immediately with npm's `could not determine executable to run`.

**Cause.** `caesar` is a standalone binary installed on the PATH, never an npm dependency of the project: there is nothing under `node_modules/.bin` for npx to find, whatever the project.

**Remedy.** Call `caesar` directly. `command -v caesar` tells where the binary lives; `caesar doctor` confirms what it can reach. If the shell finds nothing, the installation itself is missing — not the project's `package.json`.

### `caesar gc` keeps a worktree whose diff was already applied

**Symptom.** `caesar gc` reports a finished task's worktree as kept — "unintegrated changes", or "modified since its application" — even though its diff has landed in the workspace.

**Cause.** Three possibilities: the diff entered the workspace by another path than `caesar apply` (manual copy, re-implementation), so the application was never recorded and gc will not deduce it from content alone; or the worktree changed after the application, and what changed is precisely what was never applied; or the application predates the version of caesar that records it.

**Remedy.** `caesar diff <id>` shows what the worktree still carries. Re-run `caesar apply <id>` if it should land; once settled — or when the work is known to be integrated — `caesar gc --force` removes what gc could not prove applied.

## Next steps

- [Configuration](./reference/configuration.md) — the policy rules and worktree settings most of these entries point back to.
- [CLI reference](./reference/cli.md) — the exact flags for `gc`, `ps`, `diff`, `apply`, `cancel`.
