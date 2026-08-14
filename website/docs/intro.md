---
title: Introduction
sidebar_position: 1
slug: /intro
description: caesar lets a coding agent delegate tasks to external agent CLIs, isolated on disposable worktrees and reconciled against git diff.
---

{/* Source: README.md — manual resync */}

# Introduction

caesar is an orchestrator that lets a coding agent — typically Claude Code — delegate tasks to **external** sub-agents (Codex, Antigravity, OpenCode, Copilot, or even another Claude Code instance) run as plain CLI processes, exactly the way it would delegate to a native sub-agent.

The problem it solves: every coding-agent CLI has its own way of receiving a mission, returning a report, and signaling that it needs a clarification. Without a common layer, comparing two providers on the same task — or simply making a round-trip with one of them reliable — means relearning its format every time, and taking its word for what it claims to have modified. caesar normalizes that cycle.

It ships as a CLI (`caesar`), a ten-tool MCP server to drive all of it from Claude Code (or any other MCP client), a configuration TUI, and a multi-runtime skill with five commands that teaches the main agent how to direct caesar rather than execute the work itself.

## The three pillars

1. **A common communication standard, no SDK required.** OACP (Orchestrator–Agent Contract Protocol) is a plain file-based contract — a task directory, environment variables, JSON files — that any CLI can speak by reading and writing files, whether or not it was built with caesar in mind.
2. **An engine that isolates each task on a disposable git worktree.** Nothing touches the main repository until you decide it should: `caesar diff` shows what changed, `caesar apply` integrates it.
3. **Systematic reconciliation between what the agent declares and what `git diff` observes.** The diff is the source of truth, never the agent's word alone.

## What you actually gain

| Axis | Without caesar | With caesar |
|---|---|---|
| **Time** | One agent at a time in your working tree; each CLI's quirks relearned by hand. | N tasks in parallel (`max_parallel`, slots shared across processes), one flow for five providers. A copy-on-write workshop is ready in seconds — a 975 MB `node_modules` clones in 6.3 s and 11 MB of disk, versus 15.0 s and 994 MB for an ordinary copy. |
| **Risk** | The agent writes directly into the repository, and you take its report on faith. | A disposable worktree; nothing reaches the repository before an explicit `caesar diff` then `caesar apply`; changes are verified against git, not merely declared; in-place writing is refused by default. |
| **Cost & flexibility** | Locked into one provider's tool or subscription. | Draw on several providers' quotas from a single orchestrator, pick a model per task or per role (`[models]`, `role.model`), and put providers in competition on the same objective (`/caesar-race`) to keep only the best diff. |

## Supported agents

| Agent | Identifier | Headless mode | Network |
|---|---|---|---|
| Codex | `codex` | `codex exec --json -s <read-only\|workspace-write> …` | write mode only |
| Antigravity CLI | `antigravity` | `agy --print <prompt> --output-format stream-json --mode <plan\|accept-edits> …` | open |
| OpenCode | `opencode` | `opencode run --format json --dir <workspace> …` | open |
| GitHub Copilot CLI | `copilot` | `copilot --prompt <prompt> --output-format json --no-color --log-level none …` | controllable |
| Claude Code | `claude` | `claude --print <prompt> --output-format stream-json --verbose --permission-mode <plan\|acceptEdits> …` | open |

`claude` is in the catalog — delegating from one Claude Code instance to another makes sense, cross-review for example — but it is refused by default (`allow_recursion: false`) precisely because it is the case most likely to loop. Lifting that refusal is explicit: enabling the agent or allowing it in the policy.

## Where to go next

- [Installation](./getting-started/installation.md) — prerequisites and first setup.
- [Quickstart](./getting-started/quickstart.md) — a complete delegate → diff → apply round-trip.
- [The OACP standard](./protocol/overview.md) — the file-based contract behind every delegation.
