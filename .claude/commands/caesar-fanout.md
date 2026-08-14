---
description: Split a piece of work into independent objectives, delegate them all at once to external coding agents, and present each diff separately.
argument-hint: [the body of work to split]
---

Fan this work out across several external coding agents: **$ARGUMENTS**

1. **Cut it into independent objectives.** Read the code first, then split on real seams. Independence
   is not a wish, it is a property to verify before delegating:
   - no file appears in two objectives;
   - no objective needs another's output;
   - no objective moves, renames or deletes something another one reads.

   If two pieces share a file, merge them into one objective or run them in sequence. Diffs from tasks
   that touched the same file will not land together.

2. **Size the batch.** `max_parallel` is 4 by default and is enforced across processes, so a larger
   batch simply queues. Prefer fewer, well-cut objectives over many that wait. Say how the work was cut
   and why each piece is independent, before delegating.

3. **Write one complete brief per objective.** Each sub-agent is a separate process that sees only its
   own brief: `objective`, `context` (inlined, not referenced), `constraints`, and
   `acceptance_criteria` that can be checked without asking. Shared background is repeated in every
   brief, not assumed.

4. **Delegate them all back to back.** One delegation call per objective, without waiting in between,
   with `mode: "write"` and `isolation` left alone. Collect every returned task id.

5. **Collect them with a single wait call**, passing every task id at once. That is the whole reason
   the delegations do not block. If some come back pending, wait again with only those ids.

6. **Do not let a straggler hold the report.** Stop waiting on one task that is far past what its
   objective warrants, cancel it, and report the rest. Name what did not finish and what is known
   about it.

7. **Present per task.** For each finished task: its objective, its report status and summary, its
   findings, and its diff. Keep them separate — one task, one diff, one decision. State which
   acceptance criteria each one met. Then stop.

## What not to do

- Don't fan out objectives that share files; that is one objective, badly split.
- Don't wait on the tasks one at a time.
- Don't merge the diffs into a combined patch. They apply, or fail to apply, one at a time.
- Don't apply anything without being asked, and never apply a batch wholesale to save round trips.
- Don't cut the work into more pieces than the parallelism limit allows just to look busy.
- Don't paper over a conflict between two diffs; report it as a cutting mistake and say where the seam
  should have been.
