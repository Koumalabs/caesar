---
description: Run the same objective on several external coding agents in parallel and lay their competing proposals side by side, without picking one.
argument-hint: [the objective to race]
---

Race this objective across several providers: **$ARGUMENTS**

1. **Write one objective, shared by every provider.** The comparison only means something if the task
   was identical: the same `objective`, `context`, `constraints` and `acceptance_criteria` go to every
   provider, word for word. Read the code first so the objective names what actually exists; each
   sub-agent is a separate process that sees only this brief.

2. **Pick the providers.** Two by default — a third rarely adds information and costs a third more.
   Call `orch_list_agents` and race only providers that are both installed and allowed by the current
   policy. If a requested provider is unusable, say so and skip it rather than launching a delegation
   already known to fail. If only one is usable, stop: that is a single delegation, not a race.

3. **Delegate to each provider back to back**, without waiting in between. Pass `agent` explicitly,
   never `role` — a role would resolve to one provider and defeat the point. Use `mode: "write"` and
   leave `isolation` alone: each provider gets its own disposable worktree, which is what lets them
   work on the same files without colliding. Collect every task id.

4. **Collect them with a single wait call**, passing every task id at once. Wait again with only the
   ids still pending. Use the status or log tools on one task when its outcome needs a closer look.

5. **Do not let one provider hold the comparison.** Stop waiting on a provider far past what the
   objective warrants, cancel it, report it as unresolved, and present the ones that finished.

6. **Compare and stop.** For each provider that finished, fetch its diff and present, side by side: the
   report status and summary, the findings, and the patch. Say for each which acceptance criteria it
   meets. Be explicit that these are **competing proposals**, of which exactly one — or none — will be
   kept. Do not rank them as if one were obviously right unless asked to recommend.

7. **Apply only on an explicit choice**, and only the chosen task's result.

## What not to do

- Don't decide for the user which proposal wins.
- Don't merge two proposals into a third patch. They were produced from the same base by processes that
  never saw each other; the combination is code no provider ever ran.
- Don't pass `isolation: "inplace"` — providers running in parallel in one tree would stomp on each
  other, and it is refused in a git repository anyway.
- Don't wait on providers one at a time.
- Don't apply more than one result for the same objective, ever.
- Don't retry a failed or hung provider in a loop; report it and move on.
