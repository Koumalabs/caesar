#!/usr/bin/env bash
# Construit l'exécutable autonome `caesar` (tâche 12) : un unique binaire, sans
# Node, ni Bun, ni node_modules requis sur la machine cible.
#
# Deux étapes :
#   1. `tsc -b` — dist/ à jour pour tous les packages compilés (@caesar/core,
#      @caesar/protocol, @caesar/mcp-channel, @caesar/mcp-server, @caesar/cli).
#      `bun-entry.ts` les importe via leurs "main"/dist compilés, à
#      l'exception d'@caesar/tui, importé directement depuis sa source .tsx —
#      jamais concerné par tsc.
#   2. `bun build --compile packages/cli/src/bun-entry.ts` — embarque le
#      runtime Bun, le CLI et le TUI (OpenTUI compris, cœur natif inclus)
#      dans un seul fichier.
#
# Sortie dans dist-bin/ (racine du dépôt), ignoré par git — jamais dist/,
# déjà pris par les sorties de tsc de chaque package.
#
# Arguments supplémentaires transmis tels quels à `bun build` : utile pour
# essayer une cible croisée, p. ex. :
#   scripts/build-binary.sh --target=bun-linux-x64
# (voir le rapport de la tâche 12 pour ce que cela donne en pratique — les
# binaires natifs par plateforme d'OpenTUI ne sont installés que pour la
# machine courante par pnpm, la cible étrangère est susceptible d'échouer).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist-bin"
OUT_FILE="$OUT_DIR/caesar"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun est introuvable dans le PATH : requis pour produire l'exécutable autonome (https://bun.sh)." >&2
  exit 1
fi

echo "1/2 — pnpm exec tsc -b (dist/ à jour pour tous les packages sauf @caesar/tui)"
(cd "$ROOT_DIR" && pnpm exec tsc -b)

mkdir -p "$OUT_DIR"

echo "2/2 — bun build --compile packages/cli/src/bun-entry.ts"
bun build "$ROOT_DIR/packages/cli/src/bun-entry.ts" --compile --outfile "$OUT_FILE" "$@"

echo "Exécutable produit : $OUT_FILE"
