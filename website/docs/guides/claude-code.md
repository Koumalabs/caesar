---
title: Using from Claude Code
sidebar_position: 5
description: Register caesar as an MCP server for Claude Code and let the deposited skill and commands direct delegations for you.
---

{/* Source: README.md, .claude/skills/caesar/SKILL.md, .claude/commands/caesar-delegate.md, .claude/commands/caesar-fanout.md, .claude/commands/caesar-race.md, .claude/commands/caesar-review.md, .claude/commands/caesar-tasks.md — manual resync */}

# Using from Claude Code

Register the MCP server with Claude Code:

```bash
caesar mcp install claude --root <your-project>
# runs: claude mcp add caesar -- caesar mcp serve --root <your-project>
```

`caesar mcp install` also works with `codex`, `copilot`, `opencode` and `antigravity` (installation via a native subcommand for `claude`/`codex`, via a merged configuration file for the other three — `--dry-run` shows what would be done without executing or writing anything). Once registered, Claude Code exposes ten tools prefixed `mcp__caesar__`; the full detail of each lives in the [MCP tools reference](../reference/mcp-tools.md).

| Tool | What it does |
|---|---|
| `caesar_delegate` | Starts a task on an external agent and returns immediately with a task id. |
| `caesar_await` | Waits for one or more tasks and collects their results. |
| `caesar_status` | A cheap, non-blocking check of a task's current state. |
| `caesar_logs` | The normalized events for a task, useful when a result looks wrong. |
| `caesar_cancel` | Stops a task manually. |
| `caesar_diff` | The diff a task produced, before anything is applied. |
| `caesar_apply` | Integrates a task's diff into the main repository. |
| `caesar_list_agents` | Which providers are installed and allowed right now. |
| `caesar_list_roles` | The configured roles, their fallback chains, and which agent each resolves to today. |
| `caesar_answer` | Answers a question a sub-agent asked over the return channel. |

## The agentic knowledge: skill and commands

What makes a delegation as natural as invoking a native sub-agent is not these ten tools taken in isolation: it is the `caesar` skill, deposited by `caesar init` with the main agent, which teaches it how to use them.

**Direct, don't execute.** The skill teaches the main agent to brief an external executor for a precise task, to launch several at once without waiting for one to start the next, and to never take what comes back at its word: the diff decides, not the sub-agent's summary.

Five commands follow directly from it, one per gesture:

| Command | What it does |
|---|---|
| `/caesar-delegate` | Have an external coding agent implement something on a disposable worktree, then present its report and diff for review. |
| `/caesar-fanout` | Split a piece of work into independent objectives, delegate them all at once to external coding agents, and present each diff separately. |
| `/caesar-race` | Run the same objective on several external coding agents in parallel and lay their competing proposals side by side, without picking one. |
| `/caesar-review` | Get a diff or a piece of code reviewed read-only by an external coding agent other than the one that wrote it, with findings ordered by severity. |
| `/caesar-tasks` | Report the state of delegated tasks — what is running, what finished, what is stuck — and cancel what should die. |

In a runtime where the skill is deposited, asking is enough — *"delegate the implementation of X to Codex"* — and the main agent is guided through the `caesar_delegate` → `caesar_await` → report-and-diff sequence itself, without blocking the conversation while the external agent runs. Under Claude Code, the five commands above give that same sequence explicitly, without depending on the skill's automatic triggering.

`caesar init` detects the runtimes present on the `PATH` and deposits (or refreshes) the skill and commands for them; re-running `caesar init` without `--force` on an already-initialized project only refreshes the skill and commands — `.caesar/config.toml` and the roles, which you edit by hand, stay intact.

## Next steps

- [Delegating tasks](./delegating.md) — how to write a brief the skill's discipline expects.
- [The OACP standard](../protocol/overview.md) — the file-based contract underneath every one of these tools.
