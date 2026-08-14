---
title: Migrating from orch
sidebar_position: 7
description: caesar was previously named orch — the rename is a clean break, and here is what to redo by hand.
---

{/* Source: README.md — manual resync */}

# Migrating from orch

caesar was previously called `orch` (repository `agent-orchestrateur`). The rename is a clean break: nothing the old name put in place is read or migrated automatically. Concretely, on a machine or a project that used `orch`:

- the projects' `.orch/` directories (state, worktrees, config) and the global config `~/.config/orch/` are ignored — redo `caesar init` in each project (see [Installation](../getting-started/installation.md)) and `caesar init --global`, then delete the old directories by hand;
- the `orch/*` branches and worktrees still present are no longer recognized by the GC — clean them up with `git worktree remove` / `git branch -D`;
- the `orch` MCP registrations with the clients remain orphaned — remove them (`claude mcp remove orch`, `codex mcp remove orch`, edit the Copilot/Antigravity/OpenCode config) then re-register with `caesar mcp install <client>`;
- the assets deposited under the old name (`.claude/skills/orch/`, `.claude/commands/orch-*.md`, `.agents/skills/orch/`) become obsolete — `caesar init` deposits the new ones, the old ones are to be deleted by hand.

## Next steps

- [Installation](../getting-started/installation.md) — the checkout-based setup for the renamed project.
- [Using from Claude Code](./claude-code.md) — re-registering the MCP server and the skill under the new name.
