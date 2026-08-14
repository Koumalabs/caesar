---
description: Report the state of delegated tasks — what is running, what finished, what is stuck — and cancel what should die.
argument-hint: [optional task ids or a focus]
---

Report the state of the delegated tasks. Focus, if given: **$ARGUMENTS**

1. **Take the inventory.** Run `caesar ps`. Without a filter it lists everything still active plus the ten
   most recently finished tasks, and it reports the process status and the report status in separate
   columns — a task can exit cleanly while its own report says it failed. `caesar ps --status running` and
   friends narrow it; the known statuses are `pending`, `running`, `succeeded`, `failed`, `cancelled`,
   `timed_out`.

2. **Look closer at whatever is puzzling.** `caesar logs <id>` shows the normalized events;
   `caesar logs <id> --raw` shows the provider's own output, which is where a silent failure usually
   explains itself. Reach for it when a task ran far longer than its objective warrants, when a report
   contradicts its status, or when nothing has happened for a while.

3. **Take a snapshot of everything in flight** with `caesar watch --once` — one frame, then exit. Never run
   `caesar watch` without `--once`: it is an interactive terminal view that redraws and does not
   terminate.

4. **Notice what is waiting on an answer.** A sub-agent blocked on a question through the back-channel
   looks exactly like one that is stuck. Pending questions are surfaced by the status and wait tools —
   answer them rather than letting the task time out guessing.

5. **Cancel what should die.** `caesar cancel <id>` on anything hung, superseded, or running against an
   objective that no longer matters. Say what is being cancelled and why before doing it. A task killed
   outright elsewhere may still read as `running`; that reconciles itself on read, and `caesar gc` both
   reconciles and collects the worktree it was holding.

6. **Report, don't tidy.** Summarize: what is running and for how long, what finished and with which two
   statuses, what is waiting on a slot or on an answer, what was cancelled. Point at the worktrees that
   still hold unreviewed work.

## What not to do

- Don't run `caesar watch` without `--once`.
- Don't cancel a task just because it is slow; check what its logs say first.
- Don't run `caesar gc` as a reflex — it removes the worktrees of finished tasks, and their diffs with
  them. Use `caesar gc --dry-run` first, and never `--force` without being asked.
- Don't apply a diff found sitting in a finished task while taking inventory.
- Don't report a `succeeded` process as a success without reading its report status.
