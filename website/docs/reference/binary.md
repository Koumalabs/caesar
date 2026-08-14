---
title: Standalone binary
sidebar_position: 6
description: caesar also builds into a single ~70 MB executable with no Node, no Bun, and no node_modules required on the target machine.
---

{/* Source: README.md §Standalone executable — manual resync */}

# Standalone binary

`caesar` also builds into a single binary, with no Node, no Bun, and no `node_modules` required on the target machine: `bun build --compile` embeds the Bun runtime, the CLI and the TUI (OpenTUI and its native core included) into a single file.

```bash
pnpm run build:binary   # equivalent to scripts/build-binary.sh — builds dist-bin/caesar
```

Produces `dist-bin/caesar` (directory ignored by git; ~70 MB, Bun and OpenTUI embedded). Usable directly, without installation:

```bash
dist-bin/caesar doctor
dist-bin/caesar mcp serve --root <project>
dist-bin/caesar config --root <project>
```

This binary embeds Bun: the project's initial trade-off ("Node everywhere, Bun for the TUI alone", justified by the MCP server having to run without Bun) no longer applies to it — `caesar config` there mounts the TUI directly in the current process rather than looking for an external `bun`, and `caesar run --channel` self-invokes (`caesar channel serve --task-dir <dir>`, an internal subcommand hidden from the help) rather than resolving `@caesar/mcp-channel` through `node_modules`, absent from a compiled binary. The Node path used elsewhere in this documentation (`pnpm run caesar`, `pnpm exec tsc -b`) remains the everyday development path in this monorepo, and keeps working identically — these two behaviors only activate in the binary, never under Node.

:::note Cross-compilation fails today
`--target=bun-linux-x64` and friends (via `scripts/build-binary.sh --target=bun-linux-x64`) fail: OpenTUI depends on a package of per-platform native binaries (`@opentui/core-<platform>`), of which pnpm installs only the current machine's. Producing a binary for another platform means re-running the pnpm install on that platform (or in an environment targeting it) before compiling.
:::

## Next steps

- [TUI](./tui.md) — what `caesar config` needs when it is *not* the compiled binary (Bun on the PATH).
- [Installation](../getting-started/installation.md) — the everyday, Node-based setup this binary is an alternative to.
