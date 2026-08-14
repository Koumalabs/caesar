---
title: MCP tools
sidebar_position: 3
description: The ten mcp__caesar__ tools — what each does, its main parameters, and what it returns — plus the return channel injected into sub-agents.
---

{/* Source: packages/mcp-server/src/tools/delegate.ts, await.ts, status.ts, logs.ts, cancel.ts, diff.ts, apply.ts, list-agents.ts, list-roles.ts, answer.ts, packages/mcp-channel/src/server.ts — manual resync */}

# MCP tools

Once `caesar mcp install` has registered the server with a client, it exposes ten tools prefixed `mcp__caesar__`. They are two façades over the same engine as the CLI: a native sub-agent (Claude Code, or any other MCP client) drives delegations through these calls instead of shelling out to `caesar run`.

### `caesar_delegate`

Starts an objective on a sub-agent (`codex`, `antigravity`, `opencode`, `copilot`, or `claude`) running as a separate CLI process, read-only or write, optionally isolated on a disposable git worktree.

**Parameters.** `objective` (required); at least one of `role` or `agent` (an explicit `agent` wins over the one a `role` would have picked, while the role's other defaults still apply); `mode`, `isolation`, `network`; `context`, `constraints`, `acceptance_criteria`; `model`; `timeout`; `channel` (opt-in to the MCP back-channel, see below).

**Returns.** `task_id`, the resolved `agent`/`mode`/`isolation`/`network`/`model`, the `workspace`, and `status: "running"` — plus any `*_warning` field the resolution produced (a workspace root mismatch, a network guarantee that could not be honoured, a model default that had to be dropped). A policy refusal or an unknown role/agent comes back as an error result instead of a `task_id`.

:::note This call does not wait
`caesar_delegate` returns as soon as the agent is resolved and the delegation is approved by policy — **it does not wait for the sub-agent to finish**, which can take from seconds to the configured timeout. The task is still running when this returns: call `caesar_await` with the returned `task_id` to get the actual result. To run several providers on the same objective in parallel, call `caesar_delegate` repeatedly back to back, then a single `caesar_await` with every `task_id` — that not blocking is the whole point.
:::

### `caesar_await`

Waits for one or more tasks started by `caesar_delegate` to finish, and returns their normalized reports.

**Parameters.** `task_ids` (array, required); `timeout_ms` (defaults to 30 seconds).

**Returns.** Per task: `status`, `agent`, `role`, and once done, a `report` (`summary`, `changes`, `findings`, `questions`…). Tasks still running when `timeout_ms` elapses come back with `pending: true` instead of a report — and, if the sub-agent has called `ask_orchestrator` and is still waiting on an answer, with `pending_questions` listing what it asked, so a task waiting on you is never indistinguishable from one simply still working.

The report's `changes_verified_by` says how much to trust the files-changed list: `"git"` means it was cross-checked against the actual git state of the workspace (true whenever the workspace is a git repository, in both isolations); `"declaration"` means no git check was possible and it is only the sub-agent's own claim.

### `caesar_status`

A cheap, non-blocking snapshot of a task — never the full report, and never waits.

**Parameters.** `task_id`.

**Returns.** `status` (the process outcome — `pending`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out`), timestamps, `agent`, `role`, `mode`, `isolation`, the `last_event` recorded so far, and `pending_questions`. Once the task has produced a report, `report_status` (`success`, `partial`, `failed`, `blocked` — the sub-agent's own verdict) is also included. `status` reflects only the process outcome, not what the sub-agent reported: a sub-agent that writes `{"status":"failed"}` and still exits `0` shows `status: succeeded` here — check `report_status` too before assuming a task actually succeeded.

### `caesar_logs`

An excerpt of a task's activity — normalized events by default, or the sub-agent's raw CLI output with `raw: true`. Use it to diagnose a task that failed, timed out, or produced a surprising report; `caesar_status` and `caesar_await` deliberately omit this level of detail to stay compact.

**Parameters.** `task_id`; `raw` (bool); `limit` (most-recent normalized events to return, default 50, ignored when `raw` is true).

**Returns.** `total_events` plus the most recent events (or the raw text, truncated to a fixed tail size), so you know how much was cut off.

### `caesar_cancel`

Cancels a task that is still running: signals the sub-agent process to stop (`SIGTERM`, escalating to `SIGKILL` if it does not exit) and waits for the shutdown to complete before returning.

**Parameters.** `task_id`.

**Returns.** `cancelled` (bool), `status`. Safe to call on a task that already finished — it is then a no-op that just reports the final status, `cancelled: false`.

### `caesar_diff`

The git diff of a task run with worktree isolation: which files changed, how, and the full unified patch. Use it after `caesar_await` reports a task done, to inspect what it actually did before deciding whether to `caesar_apply` it — especially when the same objective was delegated to several providers in parallel and you want to compare their diffs before picking one.

**Parameters.** `task_id`.

**Returns.** `is_empty`, `files`, `patch`. `is_empty: true` with no patch for tasks that ran `inplace` (no worktree) or made no changes.

### `caesar_apply`

Applies a worktree task's diff to the main repository (`git apply --3way`); never commits, never touches branches. Use it once you have reviewed the result — typically via `caesar_diff` — and decided to keep it.

**Parameters.** `task_id`.

**Returns.** `applied` (bool), `conflicts`. Reports conflicts instead of a partial apply when the patch no longer applies cleanly; a no-op (`applied: true`, no conflicts) for tasks that ran `inplace` or made no changes.

### `caesar_list_agents`

Lists every sub-agent provider caesar knows about: whether its CLI is actually installed on this machine, what it can do (native read-only mode, structured output, resumable sessions, model selection…), the default model configured for it, and whether the current policy would allow delegating to it right now. Call this before `caesar_delegate` when unsure which providers are usable, or to compare providers before racing several of them in parallel.

**Parameters.** None.

**Returns.** `agents[]` — `id`, `display_name`, `bin`, `installed`, `path`, `capabilities`, `default_model` (if configured), `policy` (`allowed`, or `allowed: false` with the refusal reason).

### `caesar_list_roles`

Lists the roles configured for the project: purpose, default mode/isolation/network, the model it requests if any, and — resolved right now against installed binaries and the current policy — which agent `caesar_delegate` would actually pick for it, including the fallback chain and why any earlier candidate was skipped. Use it to decide between delegating through a role or naming an agent directly.

**Parameters.** None.

**Returns.** `roles[]` — `name`, `purpose`, `mode`, `isolation`, `network`, `timeout_ms`, `model`, `agents` (fallback order), `would_pick`, `reason`, `skipped`.

### `caesar_answer`

Answers a question a delegated sub-agent asked mid-run via its `ask_orchestrator` tool. It does not list pending questions itself — discover them first via `caesar_status` (a single task) or `caesar_await` (tasks it is still waiting on).

**Parameters.** `task_id`, `question_id`, `answer`.

**Returns.** `answered: true`. Answering an unknown `task_id`/`question_id`, or a question that already has an answer, fails clearly instead of writing silently.

## The return channel

Passing `channel: true` to `caesar_delegate` loads a small MCP server (`@caesar/mcp-channel`) inside the sub-agent's own process, reachable only during that task's execution — a provider that cannot load an MCP server simply ignores the field. Alongside a `get_task` convenience (re-reads the mission from `task.json`), three tools turn the delegation into a dialogue rather than a mute round trip:

- **`report_progress`** — `(message, pct?)`. Appends a progress event to the task's log, visible to the orchestrator via `caesar_status`/`caesar_logs` without ending the task.
- **`ask_orchestrator`** — `(question, options?)`. Records the question immediately, so it surfaces in `caesar_status`/`caesar_await` as a `pending_questions` entry, then blocks until `caesar_answer` provides an answer or a timeout elapses (5 minutes by default, never longer than what remains of the task's own deadline). With no answer in time, the call returns normally — not an error — inviting the sub-agent to proceed on its own best judgment.
- **`submit_report`** — the most reliable of the four report-recovery tiers: hands in the final report, validated immediately against the report schema.

Off by default: enabling it adds a process and a configuration injection to every delegation, so it is opt-in rather than automatic.

## Next steps

- [Using from Claude Code](../guides/claude-code.md) — registering these tools and the skill that directs them.
- [The OACP standard](../protocol/overview.md) — the file-based contract these tools sit on top of.
- [Delegating tasks](../guides/delegating.md) — what to delegate, and how to brief it.
