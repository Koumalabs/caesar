---
title: TUI
sidebar_position: 4
description: caesar config, the interactive configuration TUI — navigation, editing scope, and what each of its five screens edits.
---

{/* Source: README.md §Configuration interface, packages/tui/src/App.tsx, packages/tui/src/screens/AgentsScreen.tsx, packages/tui/src/screens/RolesScreen.tsx, packages/tui/src/screens/PolicyScreen.tsx, packages/tui/src/screens/IntegrationsScreen.tsx, packages/tui/src/screens/PromptEditor.tsx — manual resync */}

# TUI

`caesar config` launches an interactive TUI (OpenTUI + React) to edit policy, roles, agents and MCP integrations. It has one requirement of its own: it runs under Bun, not Node — OpenTUI renders through Bun's FFI, unavailable on Node 24.

:::warning Requires Bun
Without `bun` on the PATH, `caesar config` explains the situation and points to the equivalent subcommands rather than failing dryly:

```
$ caesar config
The configuration TUI requires Bun: OpenTUI renders through its FFI, which Node 24 does not allow […]. "bun" was not found in the PATH.
Install Bun (https://bun.sh), or use the equivalent subcommands:
  - caesar policy show   Effective policy (allow/deny, provenance).
  - caesar role list     Roles, fallback agents, the agent picked today.
  - caesar agents list   Agent catalog: presence, capabilities, authorization.
```
:::

`@caesar/core` remains in every case the single source of truth for the configuration — the three layers described in [Configuration](./configuration.md), merged: the TUI, these subcommands and the MCP server are different facades over it, and none re-reads or rewrites it on its own account.

## Navigation

- `Tab` / `Shift-Tab`, or `1`-`4` — switch screens.
- `s` — save the pending changes on the active layer. Nothing is written to disk before it, except the system prompt editor, which writes on `Ctrl+S`.
- `p` — cycle the editing scope: global → project → local. Switching scope with pending changes asks for confirmation before discarding them.
- `?` — show the help overlay.
- `q` or `Ctrl+C` — quit, with confirmation if changes are pending.

The active scope stays visible at all times, together with the file path that `s` will write — knowing "project layer" does not say *where* that is, and that is precisely what one wants to check before saving.

## Agents

A catalog table (presence, permission, capabilities) with the selected agent's detail below it: presence, version, capabilities, permission, the roles that employ it, and — for a **declared** agent (`[[agent]]`) — its editable fields (display name, binary, arguments, network arguments, directory mode, native read-only).

- `↑↓` — pick an agent.
- `Space` — allow / deny (writes the policy list; `denied` always wins).
- `m` — the agent's default model, native agents included (the `[models]` table).
- `n` — declare a CLI the native catalog does not know: the identifier is typed inline, then `bin`/`args` and the rest are refined in the detail panel.
- `x` — remove a declaration.
- `Enter` — edit a declared agent's fields.

Allowing and declaring are two different gestures: the first writes a policy list, the second adds an agent to the catalog — conflating them is the easiest misreading of this screen.

## Roles

The list of roles on the left, editing of the selected role on the right: name, purpose, agents in their fallback order, mode, isolation, network, model, timeout, and the system prompt itself — content included, not just its path.

- `↑↓` — pick a role; `n` creates one, `x` deletes it (renaming and deleting stay reserved for a role the active layer declares itself).
- On a field, `Enter` edits it, or cycles it for `mode`/`isolation`/`network`.
- On "Agents": `Enter` opens the fallback order; `Shift+J`/`Shift+K` moves the selected agent, `a` adds one, `r` removes one. The agent `caesar_delegate` would pick today is marked "← picked".
- On "Model": the model requested from whichever agent gets picked — overrides the `[models]` default, loses to an explicit `--model`/`model:`. Empty means the agent's own default.
- On "System prompt": `Enter` opens the full-screen prompt editor (below); `f` changes the declared file path.

## Policy

The fields of `[policy]` in plain language rather than raw TOML keys — each carries a label, and the TOML key it corresponds to is shown once selected, for whoever also edits the file by hand. A value inherited from a less specific layer is marked (`← global`).

- `↑↓` — pick a setting; `Enter` edits it, or opens the `allowed`/`denied` list.
- Inside a list: `a` adds an agent, `r` removes one, `Esc` returns to the settings.

The screen keeps a permanent reminder on screen: **`denied` always wins over `allowed`** — an agent present in both is denied.

## Integrations

For each of the five MCP clients (`claude`, `codex`, `copilot`, `opencode`, `antigravity`): its registration status of the `caesar` server (registered / not registered / not verifiable — `claude` and `codex` have no reliable, side-effect-free status read) and, in the detail panel, a preview of what `Enter` will actually do before it runs — the command that would execute, or the file that would be merged and under which key, with the rest of that file preserved. It is the only screen that writes outside the project, at the client's own configuration; the preview exists so that is never a surprise.

- `↑↓` — pick a client; `Enter` installs or updates the registration.

## Prompt editor

A full-screen editor for a role's system prompt — the text placed at the head of the context passed to the agent, before the task's objective. Opened from the Roles screen ("System prompt", `Enter`).

Two things set it apart from the rest of the TUI:

- **It writes immediately.** `Ctrl+S` saves the file directly, outside the global `s`/scope mechanism — a prompt is a single file, not a three-layer setting.
- **It names the file the engine will actually read**, its absolute path shown at the top — a role coming from the global layer resolves its prompt in the *current* project, never a file shared between projects.

`Esc` abandons the edit, asking for confirmation first if the text changed.

## Next steps

- [Configuration](./configuration.md) — the full `[policy]`, `[[role]]`, `[[agent]]`, `[models]` reference this TUI edits.
- [Using from Claude Code](../guides/claude-code.md) — registering the MCP server, one of the things Integrations does.
