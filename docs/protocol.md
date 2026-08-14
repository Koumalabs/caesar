# The OACP standard — Orchestrator–Agent Contract Protocol

Version `1` · documents `caesar.task/v1`, `caesar.report/v1`, `caesar.event/v1`

This document describes the contract that lets an orchestrator entrust a task to a code agent, whichever it may be, and receive a usable report back.

The contract rests on the **file system**, not on an SDK. No library is required: a program that can read and write JSON can play the role of a sub-agent. This is deliberate — a standard that requires a dependency is only adopted by those who write it.

## The cycle

```
orchestrator                                       agent
     │
     │  writes task.json
     │  starts the process with $CAESAR_* in the environment
     ├────────────────────────────────────────────────►
     │                                                │  reads $CAESAR_TASK_FILE
     │                                                │  works
     │            ◄─ events.jsonl (optional) ─────────┤
     │                                                │  writes $CAESAR_REPORT_PATH
     │  ◄─────────────────────────────────────────────┤  exits
     │  reads report.json, reconciles with git diff
```

## The task directory

Each task owns its directory, whose path is passed through `$CAESAR_TASK_DIR`:

| File | Meaning | Author |
|---|---|---|
| `task.json` | The task | orchestrator |
| `report.json` | The report | agent |
| `events.jsonl` | The progress stream, one JSON line per event | agent or adapter |
| `raw.log` | Raw process output, for diagnosis | orchestrator |
| `questions/<id>.json` | A question asked through the return channel (optional) | agent |
| `answers/<id>.json` | The answer to that question | orchestrator |

`questions/` and `answers/` only exist if the task uses the return channel (below): that is where `ask_orchestrator` and its answer meet, on the file system like the rest of the standard — no memory is shared between the agent's process and the orchestrator's.

## Environment variables

The minimal contract fits in two of them: `CAESAR_TASK_FILE` to read, `CAESAR_REPORT_PATH` to write.

| Variable | Contents |
|---|---|
| `CAESAR_TASK_DIR` | Task directory |
| `CAESAR_TASK_FILE` | Path of `task.json` |
| `CAESAR_REPORT_PATH` | Path where `report.json` must be dropped |
| `CAESAR_EVENTS_PATH` | Path of `events.jsonl` |
| `CAESAR_TASK_ID` | Task identifier |
| `CAESAR_AGENT` | Identifier of the executing agent |
| `CAESAR_DEPTH` | Delegation depth, `0` for the main agent |
| `CAESAR_PROTOCOL_VERSION` | Version of the standard |

## `task.json` — the task

```jsonc
{
  "protocol": "caesar.task/v1",
  "id": "t_7f3a",
  "created_at": "2026-08-09T10:00:00.000Z",
  "role": "reviewer",              // optional: the requested profile
  "agent": "codex",                // the selected agent
  "objective": "Fix the parser regression on empty inputs",
  "context": "…",                  // excerpts, history, links
  "constraints": ["Do not touch the public API"],
  "acceptance_criteria": ["pnpm test passes"],
  "mode": "write",                 // "read-only" | "write"
  "isolation": "worktree",         // "inplace" | "worktree"
  "network": true,                 // is the network available? (default: true)
  "workspace": "/abs/path",        // working root
  "base_ref": "3f2a91c…",          // under worktree isolation: the SHA of the starting point
  "deadline_ms": 600000,
  "depth": 1,
  "report_path": "/abs/.caesar/tasks/t_7f3a/report.json",
  "events_path": "/abs/.caesar/tasks/t_7f3a/events.jsonl",
  "channel": null                  // return channel coordinates, if available
}
```

`network` is a result, not a request: the orchestrator has already confronted what the caller wanted with what the selected agent allows. At `false`, it asserts that the network is cut off, and the brief tells the agent so — which only happens when the orchestrator knows it. An agent whose confinement it does not control receives `true`, for lack of being able to assert otherwise. The field is optional on read and defaults to `true`, so that a `task.json` written before its introduction reads back unchanged.

## `report.json` — the report

Only `protocol`, `status` and `summary` are required. Everything else has a default value: a minimal report is valid.

```jsonc
{
  "protocol": "caesar.report/v1",
  "task_id": "t_7f3a",
  "status": "success",             // success | partial | failed | blocked
  "summary": "Two files fixed, the tests pass.",
  "details": "…",
  "changes": [
    { "path": "src/parser.ts", "action": "modified", "summary": "guard on empty input" }
  ],
  "commands_run": [{ "command": "pnpm test", "exit_code": 0 }],
  "findings": [
    { "severity": "medium", "title": "…", "file": "src/x.ts", "line": 42, "detail": "…" }
  ],
  "questions": [{ "id": "q1", "question": "Should the old behavior be kept?", "options": ["yes", "no"] }],
  "next_steps": ["Document the change"],
  "artifacts": [{ "path": "bench.json", "description": "before/after measurements" }],
  "usage": { "input_tokens": 12000, "output_tokens": 3000, "duration_ms": 84000 }
}
```

The meaning of the statuses:

- **`success`** — the acceptance criteria are met.
- **`partial`** — part of the work is done; what remains is described in `next_steps`.
- **`failed`** — the agent did not succeed and has no way out.
- **`blocked`** — a decision outside its scope is required; it is asked in `questions`.

`changes` is the agent's declaration. When the task's workspace is a git repository — under `worktree` as well as `inplace` isolation — the orchestrator reconciles it with the observed git state, **which alone is the source of truth**; that is then the only case where `changes` reflects reality rather than the agent's word alone. Outside a git repository (no reconciliation possible), `changes` remains the raw declaration. The normalized report returned by `caesar_await`/`caesar_delegate` carries this distinction in `changes_verified_by` (`"git"` or `"declaration"`).

Two properties of this reconciliation deserve to be spelled out, because the worktree is a **workshop** where the sub-agent installs, runs and verifies:

- **The diff is taken against `base_ref`, never against `HEAD`.** `base_ref` is the SHA of the starting point, frozen at worktree creation. An agent that commits its work — which a workshop allows it to do — would move `HEAD` onto its own commit, and a diff against `HEAD` would come out empty: the orchestrator would conclude "no changes" and `caesar apply` would apply nothing. Against the starting SHA, the result is the same whether the agent commits or not.
- **What the orchestrator itself laid down is excluded.** The paths materialized into the worktree by `[worktree] copy`/`link` (dependencies, `.env`) are removed from the diff, with prefix semantics — a laid-down directory excludes what it contains. They are recorded in the task's record, so that `caesar diff` and `caesar apply`, which recompute the diff long afterwards, exclude them too.

## `events.jsonl` — the stream

One JSON line per event, append-only. Each line stands on its own. This is the common vocabulary into which each adapter translates its CLI's native stream, and it is what makes providers interchangeable as seen from the main agent.

```jsonc
{"protocol":"caesar.event/v1","seq":0,"at":"…","task_id":"t_7f3a","type":"started","agent":"codex","command":"codex exec …"}
{"protocol":"caesar.event/v1","seq":1,"at":"…","task_id":"t_7f3a","type":"tool_use","tool":"bash","id":"item_1","input_summary":"pnpm test","status":"started"}
{"protocol":"caesar.event/v1","seq":2,"at":"…","task_id":"t_7f3a","type":"tool_use","tool":"bash","id":"item_1","input_summary":"pnpm test","status":"succeeded"}
{"protocol":"caesar.event/v1","seq":3,"at":"…","task_id":"t_7f3a","type":"finished","status":"success","summary":"…"}
```

Available types: `started`, `thinking`, `message`, `tool_use`, `file_changed`, `progress`, `question`, `answer`, `error`, `finished`.

Two points on `tool_use`, which decide what an observer (`caesar watch`) can show of a running task:

- **Emit the `started`, not only the outcome.** A tool reported once finished teaches nothing while it runs, and that is precisely when one is watching. `codex` does it, `opencode` does not — the difference shows on screen.
- **`id`** carries the agent's call identifier, when its stream provides one, and serves to pair the start and the end of one and the same call. Without it, you have to reconcile on (name, summary), which conflates two successive executions of the same command. It is sometimes the only recourse: with `claude`, the end of a tool arrives in a block that carries only this identifier, never the name — the closing event therefore has an empty `tool`. Optional field, empty by default: logs written before its introduction read back fine.

Emitting events is **optional**. An agent that merely writes its final report remains perfectly conformant — but it will be, literally, invisible during all of its work.

## How the report is retrieved

The orchestrator tries four tiers, from most reliable to most tolerant, and keeps the best one the agent can honor:

1. **MCP return channel** — the agent calls the `submit_report` tool, validated on the fly.
2. **Native schema** — the provider constrains the final response (`codex --output-schema`, `agy --json-schema`).
3. **File contract** — the agent writes `$CAESAR_REPORT_PATH`. This is the universal tier, the one for outside agents.
4. **Degraded** — the orchestrator looks in the output for a ` ```json caesar:report ` block, failing that any JSON object declaring itself a report, and as a last resort synthesizes a report from `raw.log` and the git diff.

## The return channel, optional

When `task.channel` is filled in, an MCP server is reachable during execution and exposes four tools:

| Tool | Usage |
|---|---|
| `get_task` | Read the task back |
| `report_progress` | Signal progress (`message`, `pct`) |
| `ask_orchestrator` | Ask a question and **wait** for the main agent's answer |
| `submit_report` | Hand in the report, validated immediately |

This is what turns the delegation into a dialogue rather than a mute round trip. An agent that cannot load an MCP server simply ignores this field.

`ask_orchestrator` drops the question into `questions/<id>.json` then waits for `answers/<id>.json` to appear (polling), at most 5 minutes by default and never beyond the time remaining on the task's `deadline_ms`. Without an answer within that window, the call returns normally — it is not an error — with an invitation to proceed on the agent's best judgment rather than waiting indefinitely. On the orchestrator side, answering is symmetrical: the `caesar_answer` tool of the main MCP server (`@caesar/mcp-server`, outside the scope of this standard but provided by the reference implementation) writes `answers/<id>.json`; answering an unknown or already-answered question fails explicitly rather than writing silently.

## Conforming, in practice

The shortest conformant agent fits in a few lines:

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

Declared in `.caesar/config.toml` (section `[[agent]]`), it is orchestrable on the same footing as Codex.

## Executable schemas

The schemas are authoritative as code, and publishable as JSON Schema:

```bash
caesar protocol schema report          # JSON Schema of the report
caesar protocol schema report --strict # variant for native structured outputs
caesar protocol schema task
caesar protocol schema event
```

## Versioning

The `protocol` field carries each document's version. A reader that encounters an unknown version must refuse explicitly rather than interpret as best it can. An incompatible evolution will increment the suffix (`caesar.report/v2`), and the orchestrator will accept both for the duration of the transition.
