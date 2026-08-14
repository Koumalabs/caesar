---
name: caesar
description: Use when work should go to an external coding agent (codex, claude, copilot, opencode, antigravity) — delegating an implementation or an independent review, fanning work out in parallel, racing providers on one objective, following running delegations, or landing a returned diff.
---

# Directing external coding agents

The delegation tools — `caesar_delegate`, `caesar_await`, `caesar_status`, `caesar_logs`, `caesar_diff`,
`caesar_apply`, `caesar_cancel`, `caesar_answer`, `caesar_list_agents`, `caesar_list_roles` — run coding-agent
CLIs as separate processes. Their descriptions carry the mechanics. This document carries the
judgment: when to hand work over, how to cut it, and how to control what comes back.

Detail lives in the references:

- `references/cli.md` — the sixteen `caesar` commands, their flags and exit codes.
- `references/config.md` — configuration layers, policy, roles, and the `[worktree]` section.
- `references/troubleshooting.md` — symptom, cause, remedy.
- `references/protocol.md` — the file-based contract, for wiring a CLI that is not in the catalogue.

## You direct; you do not execute

Anything a git diff can settle belongs to a sub-agent: a mechanical implementation, a wide code
reading, a repetitive change spread over many files. What stays here is the part no diff can verify
— cutting the work up, briefing it, arbitrating what comes back, deciding what enters the
repository.

Executing is the half that leaves this process. That it also costs less is a consequence of moving
it, not the reason to move it: the reason is that a delegated implementation arrives as a reviewable
diff on a disposable branch, while an inline one arrives already merged into the workspace with
nothing to compare it against.

So the posture is not "do the work, and delegate what is left over". It is the reverse: state the
objective precisely enough that someone else can execute it, then judge the result. If the objective
cannot be stated that precisely, that is the work — and it is yours.

## What goes out, what stays

Delegate when:

- the objective is **verifiable** — tests, a build, or a diff that can be read against criteria
  written before it existed;
- the work is broad but shallow: threading a parameter through a call chain, aligning five adapters
  on a pattern already established by the sixth, porting a convention across packages;
- the work is wide reading: mapping a subsystem, finding every caller of a behaviour, explaining a
  mechanism. Use `mode: "read-only"` — nothing needs to be written to answer a question;
- an outside opinion beats another pass of your own: a provider that did not write a diff sees what
  its author structurally cannot;
- two or more pieces of the work touch disjoint files and can run at once.

Keep it when:

- **a three-line fix is not worth a delegation round-trip.** Writing a self-contained brief, waiting
  on a process, and reading its diff costs more than the edit. The threshold is not line count but
  briefing cost: if describing the change takes longer than making it, make it.
- the decision *is* the work: which of two designs, whether to break a public interface, what was
  actually asked for;
- the objective cannot be written down without the conversation. The sub-agent gets the brief and
  nothing else — no history, no earlier findings, no shared assumption;
- the honest acceptance criterion would be "looks right". Unverifiable objectives come back as
  confident prose over a diff you have no standard to judge.

Never delegate to escape a problem you have not understood. A sub-agent handed a
badly-understood problem returns a badly-understood diff, and reading it is still yours to do.

## Directing

The sub-agent is a separate process with **no access to this conversation**. Nothing said, read or
concluded here reaches it. The four fields are the whole channel:

- **`objective`** — one self-contained instruction, in real file and symbol names. Read the code
  first so the objective names what exists. "Fix the parser bug" is not an objective; "make
  `parseHeader` in `src/parse.ts` return `null` for empty input instead of throwing, and keep every
  existing caller compiling" is.
- **`context`** — what the sub-agent would otherwise have to rediscover: the relevant code inlined,
  what has already been tried and how it failed, the invariant that is not obvious from the file it
  will edit. Inline the content rather than pointing at it.
- **`constraints`** — the dos and don'ts a competent agent would otherwise get wrong: do not touch
  the public interface, no new dependencies, keep the existing test names, French comments.
- **`acceptance_criteria`** — the field that makes control possible afterwards. Write criteria a
  third party could check without asking you: `pnpm test passes`, `no file outside src/parse.ts is
  modified`, `a test that fails without the fix is added`. Vague criteria are worse than none: they
  let the sub-agent's own summary stand in for evidence, and leave you nothing to read the diff
  against.

The recurring failure is a brief written from your own working memory rather than from the file
system. Ground every delegation in what the repository actually contains.

### The arbitrations

**`role` or `agent`.** A role carries a fallback chain plus defaults for mode, isolation, network
and timeout; `caesar_list_roles` shows which agent each one resolves to right now, and why earlier
candidates were skipped. Use a role when any competent provider will do — the chain absorbs a
missing binary or a policy refusal without you deciding anything. Name an `agent` when the choice
*is* the point: racing providers, or reviewing with a provider other than the one that wrote the
code. Passing both keeps the role's defaults and overrides only its pick.

**Mode.** `read-only` for investigation and review, `write` for anything meant to land. Read-only is
enforced, not merely requested: a read-only task on a provider with no native read-only mode is run
in a worktree anyway, so that an unexpected write is contained and reported rather than promised by
the prompt.

**Isolation.** Leave it on `auto`. It already gives a write task its own worktree wherever git
allows, and `inplace` is refused for write tasks in a usable repository. When a worktree comes back
unusable — nothing installs, nothing runs — the fix is the project's `[worktree]` section, never a
fallback to `inplace`. See `references/config.md`.

**Network.** `auto` is right almost always. Pass `network: "on"` when the objective is impossible
without it — installing a dependency, cloning, fetching a URL: a refusal before launch is cheaper
than a sub-agent spending its whole budget on an install that cannot succeed.

**Budget.** The timeout defaults to ten minutes unless the role or policy says otherwise. Raising it
is rarely the right answer: an objective that needs an hour is an objective that should have been
cut up. Cutting also makes failure legible — one failed piece out of four, instead of one opaque
timeout.

## Directing several at once

Delegations do not block. Launching several and collecting them together is the most valuable thing
this toolset does, and it comes in two shapes.

**Fan-out** — *different* objectives at once, because they are independent. The natural case is a
repetitive change with real seams: five adapters to align, four packages to migrate, three
documents to regenerate from one source.

**Race** — *the same* objective on several providers, to obtain competing proposals. Use it when the
approach itself is uncertain and worth seeing twice, or before committing a long piece of work to
one provider. Two providers are usually enough; a third rarely adds information and costs a third
more.

**Cut for real independence.** Diffs only land together if the tasks never met. Before launching a
batch, verify:

- no file appears in two objectives;
- no task needs another's output;
- no task moves, renames or deletes something another one reads.

If two pieces share a file, merge them into one objective or run them in sequence. A batch whose
diffs conflict has cost more than doing the work in a single delegation — you now have two patches,
neither applicable as-is, and no provider that can reconcile them.

**Each task gets its own workshop.** A worktree under `.caesar/wt/<taskId>`, on a disposable branch
named `caesar/<role or agent>/<objective>-<8 hex>`. That is what keeps diffs attributable: readable
one at a time, applicable or discardable one at a time. It is also why racing works at all — two
providers on the same objective never see each other's files.

**Size the batch to `max_parallel`.** Four by default, and enforced *across processes*: the slots
are files under `.caesar/state/slots/`, shared by everything delegating under the same project root,
including other terminals. Ten objectives against a limit of four means six tasks queueing before
they start, and a collection call that reports them still pending. Cut into batches you can actually
hold, or delegate in waves.

**Never let a straggler hold the report.** One slow or hung provider must not delay what the others
already produced. Stop waiting on it, `caesar_cancel` it rather than leaving it running, present the
tasks that finished, and name the one that did not and what is known about it. A partial report
delivered now beats a complete one delivered too late to act on.

**Follow the set** with `caesar ps` (active tasks plus the most recently finished) or `caesar watch
--once` (one snapshot, then exit). `caesar watch` *without* `--once` is an interactive view for a
human at a terminal: it redraws and never terminates on its own — never call it.

## Controlling what comes back

**Read the diff as a reviewer, against the brief.** Compare it to the `acceptance_criteria` you
wrote, never to the sub-agent's summary — a summary reports intent, the diff reports what happened.
Look as hard at what the objective did *not* ask for: files touched outside the stated scope, a test
weakened instead of satisfied, a dependency introduced, a `TODO` left as an exit. The reconciled
file list tells you whether git confirmed it or the sub-agent merely claimed it; when the two levels
of status disagree, the process outcome tells you the run completed, the report tells you whether
the mission did. An empty diff, a stuck task, a refusal: `references/troubleshooting.md` names the
cause and the remedy for each, and the remedy is almost never a retry.

**Arbitrate a race; never merge one.** Keep exactly one proposal, or none. Two competing diffs were
produced from the same base by processes that never saw each other: hand-combining them yields code
that no provider ever ran and no test ever covered. If two proposals are each half-right, the brief
was ambiguous — rewrite it and delegate again, using the better half as `context`.

**A `partial` or `blocked` report is a verdict on the brief first.** `blocked` almost always names
the decision that was missing; `partial` names what could not be reached. Both are usually a brief
that omitted a constraint, a criterion, or a piece of context. Fix the brief and re-delegate rather
than re-running the same instruction hoping for a different outcome. Re-running unchanged is the one
loop that never pays.

**Get a second provider to review when the stakes justify it.** For anything security-relevant,
wide-reaching, or that you wrote yourself: delegate a review in `mode: "read-only"` to a provider
*other* than the one that produced the diff, with the diff inlined in `context` and its own
acceptance criteria — findings ordered by severity, nothing modified. An author reviewing their own
work reproduces their own blind spot; a different provider has different ones.

**Answer rather than let it guess.** Pass `channel: true` on a delegation where a decision you own
is likely to come up mid-run, watch for the questions surfaced with the task's status, and answer
them with `caesar_answer`. Thirty seconds of answer is cheaper than a blocked report — and much
cheaper than a plausible guess. An unanswered question does not stall forever: the sub-agent
eventually proceeds on its own judgment, so silence is a decision too.

**Applying is a decision, not a final step.** Nothing reaches the repository until it is applied.
State what is being applied and which criterion it met; when it met none, say so and leave the
worktree unapplied. Close the loop with `caesar gc` once the session's delegations are settled:
applied worktrees are collected on their own, and what gc keeps is exactly the work never applied
— or modified since its application — to settle with `caesar diff`/`caesar apply` rather than a
reflexive `--force` (see `references/cli.md`). A diff nobody can defend is not cheaper for having
been written elsewhere.

## What not to do

- Don't do the work inline and delegate the leftovers.
- Don't delegate an objective you could not check the result of.
- Don't send `isolation: "inplace"` for a write task; complete `[worktree]` instead.
- Don't wait on delegations one at a time when they were launched together.
- Don't fan out over objectives that share files.
- Don't merge two racing diffs, and don't apply more than one result for the same objective.
- Don't re-run a failed delegation unchanged.
- Don't treat a declared file list, or a summary, as evidence when a diff is available.
- Don't apply anything without saying why it passed.
