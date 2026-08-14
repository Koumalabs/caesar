#!/usr/bin/env bash
# Builds the standalone `caesar` executable (task 12): a single binary, with
# no Node, no Bun, no node_modules required on the target machine.
#
# Two steps:
#   1. `tsc -b` — dist/ up to date for every compiled package (@caesar/core,
#      @caesar/protocol, @caesar/mcp-channel, @caesar/mcp-server, @caesar/cli).
#      `bun-entry.ts` imports them via their compiled "main"/dist, with the
#      exception of @caesar/tui, imported directly from its .tsx source —
#      never handled by tsc.
#   2. `bun build --compile packages/cli/src/bun-entry.ts` — embeds the Bun
#      runtime, the CLI and the TUI (OpenTUI included, native core included)
#      into a single file.
#
# Output in dist-bin/ (repository root), ignored by git — never dist/,
# already taken by each package's tsc outputs.
#
# Extra arguments are forwarded as-is to `bun build`: useful to try a
# cross-compilation target, e.g.:
#   scripts/build-binary.sh --target=bun-linux-x64
# (see task 12's report for how that works out in practice — OpenTUI's
# per-platform native binaries are only installed for the current machine by
# pnpm, so a foreign target is likely to fail).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist-bin"
OUT_FILE="$OUT_DIR/caesar"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found on the PATH: required to produce the standalone executable (https://bun.sh)." >&2
  exit 1
fi

echo "1/2 — pnpm exec tsc -b (dist/ up to date for every package except @caesar/tui)"
(cd "$ROOT_DIR" && pnpm exec tsc -b)

mkdir -p "$OUT_DIR"

echo "2/2 — bun build --compile packages/cli/src/bun-entry.ts"
bun build "$ROOT_DIR/packages/cli/src/bun-entry.ts" --compile --outfile "$OUT_FILE" "$@"

echo "Executable produced: $OUT_FILE"
