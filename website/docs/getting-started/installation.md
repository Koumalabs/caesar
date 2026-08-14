---
title: Installation
sidebar_position: 1
description: Prerequisites and first steps to set up caesar from a checkout of the repository, since it is not published on npm.
---

{/* Source: README.md — manual resync */}

# Installation

caesar is a pnpm monorepo. It is **not yet published on npm**: you use it from a checkout of the repository — either installed for you by the one-liner below, or checked out and driven by hand with `--root`.

## One-liner install

```bash
curl -fsSL https://caesar.koumalabs.org/install | sh
```

The script checks the prerequisites (git, Node ≥ 22, pnpm or corepack), clones the repository into `~/.local/share/caesar`, builds the CLI, and writes a `caesar` launcher into `~/.local/bin` — after which `caesar <command>` works from any project on your machine, no `--root` needed. Run it again at any time to update: same directories, `git pull`, rebuild.

Two environment variables override the locations: `CAESAR_INSTALL_DIR` (the checkout) and `CAESAR_BIN_DIR` (the launcher). The script refuses to update over local modifications in the checkout rather than discard them.

## Prerequisites

- Node ≥ 22 (developed on Node 24).
- pnpm.
- At least one supported agent CLI on the `PATH` (Codex, Antigravity, OpenCode, Copilot, or Claude Code) — caesar delegates to it, it does not bundle it.
- Bun, only if you plan to use the configuration TUI (`caesar config`) or build the standalone binary — the rest of the CLI runs on Node alone.

## Checkout and build

```bash
pnpm install
pnpm exec tsc -b        # builds all packages
```

## Initialize a project

```bash
pnpm run caesar init   --root <path-to-your-project>   # creates <project>/.caesar/config.toml + the system prompts + deposits the skill and commands for detected runtimes
pnpm run caesar doctor --root <path-to-your-project>   # which agents are installed, with which capabilities, allowed or not
```

`pnpm run caesar <command>` is the `caesar` script in this repository's own root `package.json`: it runs from here, never from the target project — hence `--root <path-to-your-project>` to tell it where to act.

:::note Not published on npm
There is no `npm install -g caesar` today. Every command above runs from a checkout of the repository via `pnpm run caesar <command> --root <path>`. Once the `caesar` binary declared in `packages/cli/package.json` is published, or linked into your own projects by the usual pnpm means, `caesar <command>` works directly on the `PATH` — no more `--root`, `resolveRoot` then walks up automatically to the first `.caesar/` or `.git/` found from the current directory.
:::

`caesar doctor` inspects the catalog of agents and cross-checks it against the effective policy. Real example, on a machine where all five agents are installed:

```
$ caesar doctor
▞▚ caesar · doctor ───────────────────────────────────────────────────────────────

╭─────────────┬─────────────────────────┬──────────────────────────┬───────────╮
│ agent       │ version                 │ capabilities             │ policy    │
├─────────────┼─────────────────────────┼──────────────────────────┼───────────┤
│ codex       │ codex-cli 0.147.0       │ net(w) ro schema msg re… │ allowed   │
│ antigravity │ 1.1.12                  │ net ro schema resume di… │ allowed   │
│ opencode    │ 1.18.16                 │ net resume model mcp     │ allowed   │
│ copilot     │ GitHub Copilot CLI 1.0… │ net± ro resume dirs mod… │ denied    │
│ claude      │ 2.1.227 (Claude Code)   │ net ro resume dirs mode… │ denied    │
╰─────────────┴─────────────────────────┴──────────────────────────┴───────────╯

DENIED BY POLICY
Intended state, unless you decide otherwise.
  - "copilot": Agent "copilot" denied: present in the policy's "denied" list.
    Allow it with "caesar agents enable copilot --global".
  - "claude": Agent "claude" denied: allow_recursion is disabled (delegating to
    Claude from Claude Code would be recursion). Enable "allow_recursion"
    (Policy tab of the "caesar config" TUI, or edit .caesar/config.toml — no
    dedicated subcommand today).
```

`allowed` reads there in green and `denied` in red — colors classify, they never carry information on their own; `--verbose` adds the binary's path and the capabilities spelled out in full.

Every command accepts `--root <dir>` (explicit project root; by default, automatic search for `.caesar/` or `.git/` walking up from the current directory). Most also accept `--json` for machine output — two exceptions: `caesar mcp serve` does not know it at all, and `caesar config` refuses it explicitly since it is an interactive TUI with nothing machine-readable to produce.

## Standalone binary

caesar also builds into a single binary with no Node, no Bun, and no `node_modules` required on the target machine. See [Standalone binary](../reference/binary.md) for how to build and run it.

## Next steps

- [Quickstart](./quickstart.md) — your first delegate → diff → apply round-trip.
