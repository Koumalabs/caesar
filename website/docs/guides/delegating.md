---
title: Delegating tasks
sidebar_position: 1
description: The command groups caesar offers, and how to write a brief a sub-agent can actually execute.
---

{/* Source: README.md, .claude/skills/caesar/SKILL.md — manual resync */}

# Delegating tasks

## Direct, don't execute

The delegation tools — `caesar_delegate`, `caesar_await`, `caesar_status`, `caesar_logs`, `caesar_diff`, `caesar_apply`, `caesar_cancel`, `caesar_answer`, `caesar_list_agents`, `caesar_list_roles` — run coding-agent CLIs as separate processes. Anything a git diff can settle belongs to a sub-agent: a mechanical implementation, a wide code reading, a repetitive change spread over many files. What stays with the main agent is the part no diff can verify — cutting the work up, briefing it, arbitrating what comes back, deciding what enters the repository.

So the posture is not "do the work, and delegate what is left over." It is the reverse: state the objective precisely enough that someone else can execute it, then judge the result. If the objective cannot be stated that precisely, that is the work — and it stays with the main agent.

### What goes out, what stays

Delegate when:

- the objective is **verifiable** — tests, a build, or a diff that can be read against criteria written before it existed;
- the work is broad but shallow: threading a parameter through a call chain, aligning several adapters on a pattern already established by one of them, porting a convention across packages;
- the work is wide reading: mapping a subsystem, finding every caller of a behaviour, explaining a mechanism (use read-only mode — nothing needs to be written to answer a question);
- an outside opinion beats another pass of your own: a provider that did not write a diff sees what its author structurally cannot;
- two or more pieces of the work touch disjoint files and can run at once.

Keep it when:

- a three-line fix is not worth a delegation round-trip — the threshold is not line count but briefing cost: if describing the change takes longer than making it, make it;
- the decision *is* the work: which of two designs, whether to break a public interface, what was actually asked for;
- the objective cannot be written down without the surrounding conversation — a sub-agent gets the brief and nothing else, no history, no shared assumption;
- the honest acceptance criterion would be "looks right" — unverifiable objectives come back as confident prose over a diff with no standard to judge it against.

## Briefing a sub-agent

A sub-agent is a separate process with no access to the conversation that spawned it. Nothing said, read, or concluded there reaches it — four fields are the whole channel:

- **`objective`** — one self-contained instruction, in real file and symbol names. Read the code first so the objective names what actually exists.
- **`context`** — what the sub-agent would otherwise have to rediscover: the relevant code inlined, what has already been tried and how it failed, the invariant that is not obvious from the file it will edit.
- **`constraints`** — the dos and don'ts a competent agent would otherwise get wrong: do not touch the public interface, no new dependencies, keep the existing test names.
- **`acceptance_criteria`** — the field that makes control possible afterwards. Write criteria a third party could check without asking: a test command that must pass, a scope that must not be exceeded. Vague criteria are worse than none — they let the sub-agent's own summary stand in for evidence.

## The command groups

`caesar --help` groups its sixteen commands by use rather than listing them in declaration order; `caesar <command> --help` gives the detail of any one. The full flags and exit codes live in the [CLI reference](../reference/cli.md).

**Getting started**
- `caesar init` — creates `.caesar/config.toml`, the default system prompts, and deposits the skill and commands for the runtimes it detects.
- `caesar doctor` — reports which agents are installed, with which capabilities, allowed or not by the effective policy.

**Delegating**
- `caesar run` — the complete round-trip: delegates, waits, returns the report.
- `caesar diff <id>` — shows what a task changed, before anything reaches the main repository.
- `caesar apply <id>` — integrates a task's worktree into the main repository.
- `caesar cancel <id>` — stops a task manually.

**Following**
- `caesar watch` — a live view of running tasks, redrawn as events arrive.
- `caesar ps` — running tasks plus the most recently finished ones.
- `caesar logs <id>` — normalized events for a task (`--raw` for the provider's own output, `--follow` to tail).
- `caesar gc` — reconciles tasks whose process died without writing a final status, and collects worktrees already applied.

**Configuring**
- `caesar agents list|enable|disable|test` — the agent catalog: presence, capabilities, authorization.
- `caesar policy show|allow|deny` — the effective policy and who may run.
- `caesar role list|show|add|remove` — roles, their fallback chain, and the agent a role resolves to today.
- `caesar config` — an interactive TUI (requires Bun) to edit policy, roles and MCP integrations.

**Integrating**
- `caesar mcp install <client>` / `caesar mcp serve` — registers caesar as an MCP server for a client, or serves the protocol on stdout.
- `caesar protocol schema <task|report|event>` — publishes the OACP standard as JSON Schema.

## Next steps

- [The workshop: worktrees](./worktrees.md) — how isolation actually works.
- [Parallel tasks](./parallel.md) — running several delegations at once.
- [Watching sub-agents](./watch.md) — following a delegation live.
