---
description: Get a diff or a piece of code reviewed read-only by an external coding agent other than the one that wrote it, with findings ordered by severity.
argument-hint: [what to review — a diff, a task id, files, or a concern]
---

Get an independent review of: **$ARGUMENTS**

1. **Assemble what is being reviewed.** If it is a delegated task's result, fetch its diff. If it is
   local work, produce the diff or read the files. The reviewer is a separate process with no access to
   this conversation, so the material has to travel inside the delegation: inline the patch and the
   surrounding code it cannot infer, not paths to them.

2. **Pick a different provider.** Call `caesar_list_agents` and choose an installed, allowed provider
   **other than the one that produced the code** — including when this session wrote it. An author
   reviewing their own work reproduces their own blind spot. Say which provider was chosen and why.

3. **Delegate read-only.** Use `mode: "read-only"`; do not pass `isolation` — a read-only task is
   isolated on its own where the provider has no native read-only mode, so that an unexpected write is
   contained and reported rather than merely promised. State in the brief what to look for: correctness
   against the stated intent, regressions, missed edge cases, error handling, and anything the diff
   changed that the intent did not ask for. Set `acceptance_criteria` that describe the review itself —
   findings ordered by severity, each naming a file and a line where one applies, and nothing modified.

4. **Wait, then read the report.** Wait for the task; wait again if it comes back pending. Check both
   the process status and the report status before treating the review as done, and fetch the events if
   the report looks thin or contradicts itself.

5. **Present the findings ordered by severity**, highest first, each with its location and what it
   would take to address it. Separate what the review demonstrates from what it merely suspects. If the
   review flagged nothing, say that plainly rather than padding it — and note what it did cover.

6. **Do not act on it.** A review is input for a decision, not the decision. Do not fix what it found
   unless asked to.

## What not to do

- Don't review it here instead of delegating; a second opinion has to come from somewhere else.
- Don't use the provider that wrote the code, and don't use `mode: "write"`.
- Don't let the reviewer modify anything, and don't apply anything after a review.
- Don't restate the diff back as if it were a finding.
- Don't inflate the severity of stylistic remarks, and don't bury a real defect among them.
- Don't present a review whose report status was `failed` or `blocked` as a clean bill of health.
