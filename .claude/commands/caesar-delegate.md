---
description: Have an external coding agent implement something on a disposable worktree, then present its report and diff for review.
argument-hint: [what to implement]
---

Delegate this implementation to an external coding agent: **$ARGUMENTS**

1. **Ground the objective.** Read the code the change touches before writing anything. Name the real
   files, functions and behaviours. The sub-agent is a separate process with no access to this
   conversation — anything not written into the delegation does not exist for it.

2. **Write the brief.** Compose `objective` (one self-contained instruction), `context` (relevant code
   inlined, what has been tried, the invariant that is not obvious), `constraints` (the dos and don'ts
   a competent agent would otherwise get wrong), and `acceptance_criteria` — criteria a third party
   could check without asking, such as a test command that must pass or a scope that must not be
   exceeded. Without verifiable criteria there is nothing to review the diff against.

3. **Delegate.** Use `role: "implementer"` unless a specific provider was named, in which case pass
   `agent` instead. Use `mode: "write"` and leave `isolation` alone — `auto` already puts the work on
   a disposable worktree. Check `orch_list_agents` first only if unsure which providers are usable.
   The call returns a task id immediately; the task is still running.

4. **Wait.** Call the wait tool with that task id. If it comes back pending, wait again rather than
   assuming failure. Use the status tool for a cheap check in between, and the log tool when a result
   looks wrong and the events matter.

5. **Stop waiting when there is nothing left to wait for.** A `failed`, `timed_out` or `cancelled`
   process is done; so is a task whose report says `failed` or `blocked`. Check both levels before
   concluding it succeeded. Cancel a task that is stuck far past what the objective warrants rather
   than leaving it running.

6. **Present, do not land.** Fetch the diff. Report the report's status and summary, its findings, the
   files changed, and the patch itself for anything non-trivial. Say explicitly which acceptance
   criteria the diff meets and which it does not. Then stop.

## What not to do

- Don't implement it here. Delegation is the mechanism, not a fallback for a slow provider.
- Don't apply the diff unless explicitly asked to apply this specific task's result. Presenting a diff
  is not being told to land it.
- Don't pass `isolation: "inplace"`. If the worktree came back incomplete, the fix is the project's
  `[worktree]` section — report that instead of retrying differently.
- Don't re-run a failed delegation unchanged, and don't quietly switch providers to get a nicer answer.
- Don't take the declared file list or the summary as evidence when the diff says otherwise; report
  the disagreement.
