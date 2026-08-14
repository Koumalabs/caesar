---
title: Standalone binary
sidebar_position: 6
description: caesar also builds into a single ~70 MB executable with no Node, no Bun, and no node_modules required on the target machine.
---

{/* Source: README.md §Standalone executable — manual resync */}

# Standalone binary

Beyond the everyday Node-based setup, `caesar` also compiles down to one self-contained binary that needs nothing else installed on the machine running it — no Node, no Bun, no `node_modules`. `bun build --compile` is what produces it: it bundles the Bun runtime itself alongside the CLI and the TUI, native OpenTUI core included, into that single file.

```bash
pnpm run build:binary   # equivalent to scripts/build-binary.sh — builds dist-bin/caesar
```

Produces `dist-bin/caesar` (directory ignored by git; ~70 MB, Bun and OpenTUI embedded). Usable directly, without installation:

```bash
dist-bin/caesar doctor
dist-bin/caesar mcp serve --root <project>
dist-bin/caesar config --root <project>
```

Because the binary carries its own Bun runtime, one constraint that shapes the rest of the project quietly disappears inside it. Elsewhere the design is deliberately "Node everywhere, Bun only for the TUI" — the MCP server specifically has to run without Bun — but a compiled binary has no such split to respect: `caesar config` mounts the TUI straight into the running process instead of shelling out to an external `bun`, and `caesar run --channel` launches itself through a hidden internal subcommand (`caesar channel serve --task-dir <dir>`) rather than resolving `@caesar/mcp-channel` from `node_modules`, which a compiled binary does not have. Neither behavior touches the regular Node workflow this monorepo uses day to day (`pnpm run caesar`, `pnpm exec tsc -b`, and so on) — both are specific to running the compiled binary.

:::note Cross-compilation fails today
Targeting another platform — `scripts/build-binary.sh --target=bun-linux-x64` and its siblings — does not currently work. The reason is OpenTUI itself: it ships as a set of per-platform native binaries (`@opentui/core-<platform>`), and pnpm only ever installs the one matching the machine it runs on. Building for a different platform means running that pnpm install on (or targeting) the platform in question first, then compiling there.
:::

## Next steps

- [TUI](./tui.md) — what `caesar config` needs when it is *not* the compiled binary (Bun on the PATH).
- [Installation](../getting-started/installation.md) — the everyday, Node-based setup this binary is an alternative to.
