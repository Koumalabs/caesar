---
title: Overview
sidebar_position: 1
description: OACP condensed — the task/report cycle, the two-variable minimal contract, and a conformant agent in ten lines of bash.
---

{/* Source: .claude/skills/caesar/references/protocol.md — manual resync */}

# Overview

OACP — the Orchestrator–Agent Contract Protocol — version `1`, documents `caesar.task/v1`, `caesar.report/v1`, `caesar.event/v1`.

The contract rests on the **file system**, not on an SDK. No library is required: any program that can read and write JSON can act as a sub-agent. That is deliberate — a standard that demands a dependency is adopted only by the people who wrote it.

## The cycle

One directory per task, its path passed as `$CAESAR_TASK_DIR`. The orchestrator writes `task.json` and starts the sub-agent's process with the `CAESAR_*` variables in its environment; the agent reads its mission, works, optionally narrates itself through `events.jsonl`, and writes `report.json` before it exits. The orchestrator then reads that report and reconciles it against the observed git diff.

## The minimal contract: two variables

Everything else is a convenience. An agent that honours only two environment variables is orchestrable:

- **`CAESAR_TASK_FILE`** — where to read the mission (`task.json`).
- **`CAESAR_REPORT_PATH`** — where to write the account of the work (`report.json`).

The rest — `CAESAR_TASK_DIR`, `CAESAR_EVENTS_PATH`, `CAESAR_TASK_ID`, `CAESAR_AGENT`, `CAESAR_DEPTH` (delegation depth, `0` for the top-level agent — this is what makes `max_depth` apply beyond the first level), `CAESAR_PROTOCOL_VERSION` — exist for agents that can make use of them, never as a requirement.

## A conformant agent in ten lines

```bash
#!/usr/bin/env bash
objective=$(jq -r .objective "$CAESAR_TASK_FILE")

# … do the work …

jq -n --arg s "Handled: $objective" '{
  protocol: "caesar.report/v1",
  status: "success",
  summary: $s
}' > "$CAESAR_REPORT_PATH"
```

Declared under `[[agent]]` in `.caesar/config.toml`, it is orchestrable on the same footing as any catalogue provider:

```toml
[[agent]]
id = "my-agent"
bin = "my-agent.sh"
args = ["{{prompt}}"]
```

The substituted tokens are `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}` and `{{model}}`. A token with no value removes its whole argument rather than leaving a residue; `{{prompt}}` is mandatory, since without it the CLI never receives the objective. `cwd_mode` (`process` / `flag`) says whether the workspace is the process's working directory or already carried by a token in `args`. See [Configuration](../reference/configuration.md) for the other `[[agent]]` fields.

## Why the file system, and not an SDK

A JSON file on disk is readable by a bash script, a Python one-liner, or a fully-fledged CLI alike — nobody has to link against caesar's own code to speak its protocol. `events.jsonl` follows the same logic: emitting it is optional, and an agent that only writes its final report is perfectly conformant — but it will be literally invisible while it works. Narrating progress is a courtesy the standard rewards, never a requirement it imposes.

## The full specification

This page is the contract condensed to what a sub-agent implementer needs first. The [complete specification](./specification.md) documents every field of `task.json`/`report.json`/`events.jsonl`, the four report-recovery tiers, and the optional MCP return channel.
