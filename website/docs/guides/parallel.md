---
title: Parallel tasks
sidebar_position: 3
description: How caesar caps and shares concurrent delegations across processes, and how it reclaims slots left behind by killed processes.
---

{/* Source: README.md, .claude/skills/caesar/SKILL.md — manual resync */}

# Parallel tasks

Several agents run at once, each in its own workshop (`.caesar/wt/<taskId>`, on a branch named to be read — `caesar/<role>/<objective>-<8 chars>`). This is the normal mode from Claude Code: `caesar_delegate` hands back immediately with a `task_id`, you launch several, `caesar_await` collects the results.

## A limit shared across processes

`policy.max_parallel` (4 by default) caps the whole — **across processes included**. Six `caesar run` invocations in six terminals, plus a Claude Code conversation that delegates: all share the same slots, materialized as files under `.caesar/state/slots/`. A `caesar run` that finds no room waits while saying so, and names who is occupying the slots:

```
$ caesar run --agent codex "…"
1 task(s) already running under this project (max_parallel = 1) — waiting for a slot. Ctrl-C to give up.
  · pid 51820 — caesar run — review the parser (since 2026-08-11T13:42:11.004Z)
```

## Reclaiming dead slots

A killed process (`kill -9`) leaves its slot file behind: the first caller that finds everything occupied checks each holder and reclaims those whose process no longer exists. A limit that could become a permanent deadlock would be worse than no limit at all.

It also leaves its task hanging. A task's status is written by the process conducting it: killed — `kill -9`, MCP session closed, machine shut down — it never writes it, and the record stays "running" indefinitely. `caesar ps` and `caesar gc` reconcile that state: a task whose marker names a vanished process moves to failed, with a report that says what happened, and the worktree it was holding becomes collectable again. The proof is positive — a pid that can no longer be found — never deduced from an absence: a task without a marker is never concluded by default, and `caesar cancel <id>` remains the manual way out.

:::note Two caveats
The wait is a poll, not a queue: between two candidates, entry order is not guaranteed. And reclaiming a dead slot relies on the pid, which only makes sense on a single machine — a `.caesar/` directory on a network share, used from two workstations, would see the other's slots as alive indefinitely.
:::

## Directing several at once

Delegations do not block. Launching several and collecting them together is the most valuable part of this toolset, and it comes in two shapes:

- **Fan-out** — *different* objectives at once, because they are independent: five adapters to align, four packages to migrate, three documents to regenerate from one source.
- **Race** — *the same* objective on several providers, to obtain competing proposals, when the approach itself is uncertain and worth seeing twice.

Before launching a batch, cut for real independence: no file appears in two objectives, no task needs another's output, no task moves, renames or deletes something another one reads. If two pieces share a file, merge them into one objective or run them in sequence — diffs from tasks that touched the same file will not land together.

Size the batch to `max_parallel`: ten objectives against a limit of four means six tasks queueing before they start. Cut into batches you can actually hold, or delegate in waves. And never let a straggler hold the report — cancel a slow or hung provider rather than delaying what the others already produced.

## Next steps

- [Watching sub-agents](./watch.md) — following what all these parallel tasks are doing.
- [Delegating tasks](./delegating.md) — how to brief a sub-agent well.
