---
title: Migrer depuis orch
sidebar_position: 7
description: caesar s'appelait auparavant orch — le renommage est une rupture nette, et voici ce qu'il faut refaire à la main.
---

{/* Source: README.md — manual resync */}

# Migrer depuis orch

caesar s'appelait auparavant `orch` (dépôt `agent-orchestrateur`). Le renommage est une rupture nette : rien de ce que l'ancien nom a mis en place n'est lu ou migré automatiquement. Concrètement, sur une machine ou un projet ayant utilisé `orch` :

- les répertoires `.orch/` des projets (état, worktrees, config) et la config globale `~/.config/orch/` sont ignorés — refaites `caesar init` dans chaque projet (voir [Installation](../getting-started/installation.md)) et `caesar init --global`, puis supprimez les anciens répertoires à la main ;
- les branches et worktrees `orch/*` encore présents ne sont plus reconnus par le GC — nettoyez-les avec `git worktree remove` / `git branch -D` ;
- les enregistrements MCP `orch` auprès des clients restent orphelins — supprimez-les (`claude mcp remove orch`, `codex mcp remove orch`, éditez la config Copilot/Antigravity/OpenCode) puis réenregistrez avec `caesar mcp install <client>` ;
- les assets déposés sous l'ancien nom (`.claude/skills/orch/`, `.claude/commands/orch-*.md`, `.agents/skills/orch/`) deviennent obsolètes — `caesar init` dépose les nouveaux, les anciens sont à supprimer à la main.

## Prochaines étapes

- [Installation](../getting-started/installation.md) — la configuration basée sur checkout pour le projet renommé.
- [Utiliser caesar depuis Claude Code](./claude-code.md) — réenregistrer le serveur MCP et la skill sous le nouveau nom.
