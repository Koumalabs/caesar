---
title: Binaire autonome
sidebar_position: 6
description: caesar se construit aussi en un exécutable unique d'environ 70 Mo, sans Node, sans Bun, et sans node_modules requis sur la machine cible.
---

{/* Source: README.md §Standalone executable — manual resync */}

# Binaire autonome

Au-delà de la configuration quotidienne basée sur Node, `caesar` se compile aussi en un binaire autonome qui n'a besoin de rien d'autre installé sur la machine qui l'exécute — pas de Node, pas de Bun, pas de `node_modules`. C'est `bun build --compile` qui le produit : il embarque le runtime Bun lui-même aux côtés de la CLI et de la TUI, noyau OpenTUI natif compris, dans ce fichier unique.

```bash
pnpm run build:binary   # equivalent to scripts/build-binary.sh — builds dist-bin/caesar
```

Produit `dist-bin/caesar` (répertoire ignoré par git ; ~70 Mo, Bun et OpenTUI embarqués). Utilisable directement, sans installation :

```bash
dist-bin/caesar doctor
dist-bin/caesar mcp serve --root <project>
dist-bin/caesar config --root <project>
```

Parce que le binaire porte son propre runtime Bun, une contrainte qui façonne le reste du projet disparaît discrètement à l'intérieur. Ailleurs, le design est délibérément « Node partout, Bun seulement pour la TUI » — le serveur MCP en particulier doit fonctionner sans Bun — mais un binaire compilé n'a aucune séparation de ce genre à respecter : `caesar config` monte la TUI directement dans le processus en cours plutôt que d'exécuter un `bun` externe en sous-processus, et `caesar run --channel` se lance lui-même via une sous-commande interne cachée (`caesar channel serve --task-dir <dir>`) plutôt que de résoudre `@caesar/mcp-channel` depuis `node_modules`, qu'un binaire compilé n'a pas. Aucun de ces deux comportements ne touche au flux de travail Node habituel que ce monorepo utilise au quotidien (`pnpm run caesar`, `pnpm exec tsc -b`, etc.) — les deux sont propres à l'exécution du binaire compilé.

:::note La compilation croisée échoue aujourd'hui
Cibler une autre plateforme — `scripts/build-binary.sh --target=bun-linux-x64` et ses semblables — ne fonctionne pas actuellement. La raison, c'est OpenTUI lui-même : il est distribué sous forme d'un jeu de binaires natifs par plateforme (`@opentui/core-<platform>`), et pnpm n'installe jamais que celui correspondant à la machine sur laquelle il tourne. Construire pour une autre plateforme signifie lancer cet install pnpm sur (ou en ciblant) la plateforme en question d'abord, puis compiler là-bas.
:::

## Prochaines étapes

- [TUI](./tui.md) — ce dont `caesar config` a besoin quand il *n'est pas* le binaire compilé (Bun sur le PATH).
- [Installation](../getting-started/installation.md) — la configuration quotidienne basée sur Node à laquelle ce binaire est une alternative.
