# Troubleshooting

Each entry: the symptom as it appears, the cause, and the remedy. Most of these are refusals or
findings that already name their own fix — read them rather than working around them.

## `inplace` refused for a write task

**Symptom.** The delegation fails before anything runs, with a refusal that says isolation `inplace`
was requested (or inherited from a role, or from the policy default) for a write task, names the
repository being protected, and offers a remedy.

**Cause.** A write task in `inplace` isolation would write straight into the working tree, on the
current branch: its changes would mix with the user's and with those of other tasks, beyond what a
diff can attribute. Refused unless all four conditions fail — `inplace` requested, write mode, usable
git repository, and no `allow_inplace_write` opt-in.

**Remedy.** Leave isolation on `worktree` or `auto`. If the worktree is unusable because untracked
files are missing, declare them under `[worktree]` — see the next entry. `allow_inplace_write = true`
under `[policy]` exists for repositories where the mixing is accepted knowingly; it is not the answer
to an incomplete worktree.

The refusal names where the isolation came from — explicit argument, role, or policy default — so
that the right file gets corrected.

## The worktree looks empty; nothing installs or runs there

**Symptom.** A low-severity finding titled along the lines of *worktree without a workshop*, listing
the paths the project appears to need. Or a task that fails for no visible reason, with the sub-agent
reporting a missing dependency.

**Cause.** A git worktree contains only tracked files. `node_modules`, `.venv`, `target`, `.env` and
every ignored directory are absent.

**Remedy.** Declare them under `[worktree] copy` (and `setup` for the install command) in
`.orch/config.toml`, or re-run `orch init --force`, which detects them. Never fall back to `inplace`.

**Related.** A path declared under `[worktree]` that cannot be placed produces a finding naming which
of the four reasons applies — absent, tracked, neither tracked nor ignored, already present — and the
key to fix. A path placed with `link` produces an informational finding: it is shared with the
workspace, so it is not isolated.

**Related.** A finding about `.orch/wt/` not being ignored by git means the project's `.gitignore` was
rewritten without it. Not fatal — git treats the worktree as a nested repository and warns on its own
— but `orch init --force` restores the line.

## The diff is empty although the agent says it wrote files

**Symptom.** `orch_diff` returns `is_empty: true` with no patch, while the report claims files were
changed.

**Causes, in order of likelihood.**

1. **The task ran `inplace`, not in a worktree.** There is no worktree to diff, so the diff is empty
   by construction — the changes are in the working tree itself. Check the isolation actually used
   (the status of the task reports it, and it may differ from what was requested: a read-only task on
   a provider with no native read-only mode is forced into a worktree, and a worktree can be declined
   when git cannot provide one).
2. **The paths are ones the orchestrator itself placed.** Everything materialized from
   `[worktree] copy`/`link` is excluded from the diff, with prefix semantics. If the sub-agent edited
   something inside `node_modules`, it will not appear.
3. **The agent did not actually write anything.** The declared file list is the agent's own claim; the
   diff is what happened. When the workspace is a git repository the two are reconciled and the
   discrepancy is added as a finding — read the findings.

An agent that *commits* inside its worktree is not a cause: the diff is taken against the base commit
frozen at creation, never against `HEAD`, so the result is the same whether it committed or not.

## The agent is refused

**Symptom.** The delegation returns an error naming the agent and the rule applied, instead of a task
id.

**Cause and remedy.** One of four rules, checked in that order — see `references/config.md` for the
full table. In short: `denied` needs `orch agents enable <id>`; an `allowlist` needs
`orch policy allow <id>`; `recursion` (the default refusal of `claude`) needs `allow_recursion` set by
hand; `depth` is not about the agent at all — the delegation chain is already `max_depth` deep.

**Target the right layer.** `orch policy show` reports the provenance of each value. A refusal
declared by the global layer is not lifted by writing to the project layer: the write would
materialize the effective list there, refusal included. Use `--global` or `--local` to match the
layer that declares the rule.

## Network not guaranteed

**Symptom.** An informational finding titled *network not guaranteed*, or a `network_warning` on the
delegation result.

**Causes.** Three distinct ones, and the wording distinguishes them:

- the provider can only open the network in write mode — `codex`, whose sandbox cuts it in read-only
  mode with no recourse. Under `auto` the task runs anyway, without network;
- the network was asked to be closed and the orchestrator does not know how to close it for that
  provider: it says so instead of promising a closure that did not happen;
- the network was demanded (`on`) on a provider whose confinement the orchestrator does not control:
  declare `network_args` on that agent so it knows how to open it explicitly.

**Remedy.** If the objective genuinely needs the network, pass `network: "on"` — the delegation then
fails outright, before launch, rather than burning a budget on an install that cannot succeed. If it
does not, declaring `network = "off"` on the role makes the intent explicit and silences the warning.

## A task stays `running` forever after a `kill -9`

**Symptom.** `orch ps` keeps showing a task as running; `orch watch` follows it endlessly; its
worktree is never collected.

**Cause.** A task's final status is written by the process conducting it, in its cleanup path. Killed
outright — `kill -9`, a closed session, a halted machine — it never writes it. The record stays
`running` forever, and a running task's worktree is protected from collection.

**Remedy.** Reconciliation is automatic on read: `orch ps` and the status/wait tools sweep abandoned
tasks first. A task whose marker names a process that no longer exists is marked `failed`, with a
report saying what happened, and its worktree becomes collectable. `orch gc` does the same sweep and
then collects.

The proof is positive — a pid that can no longer be found — never inferred from an absence: a task
with no marker at all is never concluded on its own. `orch cancel <id>` remains the manual exit.

## Waiting for a `max_parallel` slot

**Symptom.** A delegation that does not start; `orch run` prints how many tasks are already in flight,
the limit, and who holds each slot.

**Cause.** `policy.max_parallel` (4 by default) is enforced across processes, through slot files under
`.orch/state/slots/`. Everything delegating under the same project root shares them.

**Remedy.** Wait, cut the batch to the limit, or raise `max_parallel` in the layer that suits. A
killed process leaves its slot file behind, but the first caller that finds everything taken checks
each holder and reclaims the ones whose process is gone — a stale slot is not a permanent block.

## `workspace_warning` on a delegation

**Symptom.** The delegation succeeds and carries a warning saying the orchestrator delegates on one
root while the current directory belongs to a different repository.

**Cause.** The MCP registration freezes `--root` once and for all. If the working directory has since
moved to another repository (or another worktree), sub-agents work in a tree nobody is looking at.

**Remedy.** Re-run `orch mcp install` from the intended repository, or serve with
`orch mcp serve --root <repo>`. It is a warning rather than a refusal: the server's current directory
is not proof of intent, and failing the delegation on that basis would cost more than it saves. But
do not ignore it — a diff produced in the wrong tree is a diff nobody will find.

## `status: succeeded` with a report that says `failed`

**Symptom.** The task's process status is `succeeded` while the report's own status is `failed`,
`partial` or `blocked`.

**Cause.** They are two different facts and the orchestrator deliberately does not merge them: the
process status says the CLI exited cleanly; the report status is the sub-agent's own verdict on its
mission. A sub-agent that writes `{"status":"failed"}` and exits `0` produces exactly this.

**Remedy.** Check both before concluding anything. Treat the report status as the verdict on the
mission and the diff as the record of what happened. `orch run` already crosses the two before
returning exit code `0`.
