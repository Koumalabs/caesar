---
title: Watching sub-agents
sidebar_position: 4
description: caesar watch opens a live, daemon-free window onto what delegated tasks are doing, without modifying anything.
---

{/* Source: README.md — manual resync */}

# Watching sub-agents

A delegated task is not a black box: `caesar watch` opens a window onto what is happening, next to the conversation or terminal that launched the delegation.

```bash
caesar watch                 # all running tasks, redrawn frame
caesar watch t_a1b2 t_c3d4   # only these
caesar watch --once          # one frame, then exit
caesar watch --json          # NDJSON of the events, several tasks merged
```

```
▞▚ caesar · watch   1 active · max_parallel 4                             17:21:20

● t_efb5914d codex        —            25s  inplace · write
  Write three files a.txt, b.txt and c.txt, then run 'sleep 8 && ls -1'…
  ▸ shell /bin/zsh -lc 'sleep 8 && ls -1' — 3s
  ~ 3 file(s)  ·  11 event(s)

q or Ctrl-C to quit — watching modifies nothing.
```

No daemon is needed: the engine writes `events.jsonl` **during** execution and publishes task state through atomic writes. `caesar watch` only reads what another process writes — the same property that makes `caesar cancel` and the sharing of `max_parallel` work.

## Four deliberate design choices

- **A tool appears as soon as it starts**, not at its completion. That is the whole difference between seeing a three-minute `npm install` set off and discovering it at minute three.
- **Silence is displayed.** A stuck task and a working task are indistinguishable without it; past thirty seconds without a single event, the view says so.
- **A pending question jumps ahead of everything else.** A sub-agent waiting for an answer over the return channel looks exactly like a frozen sub-agent.
- **Finished tasks stay visible** for a few minutes, with their report status: a task that disappears the moment it finishes is a task whose ending you will never know.

Outside a terminal (redirection, `| tee`, script), no redraw and no ANSI sequences: one line per event, and `--json` yields usable NDJSON.

## What each agent lets you see

What you can observe during execution depends on what each CLI narrates, and that varies a lot:

| Agent | During execution |
|---|---|
| `codex` | start **and** end of every command, modified files, its progress reports |
| `claude` | tools, results, text, and an in-progress thinking signal |
| `opencode` | tools (only once finished — its stream does not announce their start), text |
| `antigravity` | its text as it streams, its errors; its tool calls are not yet translated |
| `copilot` | text, session errors; its tool calls remain unverified for lack of available quota |

These translations are written from real captures and replayed by tests. Where a shape could not be observed, the adapter says so in plain words rather than guessing.

:::note Interactive view — not for scripting
`caesar watch` without `--once` redraws and never terminates on its own; it is meant for a human at a terminal. For a single snapshot in a script or an automated flow, use `caesar watch --once` or `caesar ps` instead.
:::

Other useful subcommands while following delegations: `caesar ps` (running and recent tasks), `caesar logs <id> [--raw] [--follow]`, and `caesar cancel <id>`. See the [CLI reference](../reference/cli.md) for the full list.

## Next steps

- [Delegating tasks](./delegating.md) — the command groups, including the ones for following tasks.
- [Using from Claude Code](./claude-code.md) — the MCP equivalents of watching and following.
