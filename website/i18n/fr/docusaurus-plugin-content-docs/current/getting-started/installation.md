---
title: Installation
sidebar_position: 1
description: Prérequis et premiers pas pour configurer caesar depuis un checkout du dépôt, puisqu'il n'est pas publié sur npm.
---

{/* Source: README.md — manual resync */}

# Installation

caesar est un monorepo pnpm. Il n'est **pas encore publié sur npm** : vous l'utilisez depuis un checkout du dépôt — installé pour vous par le one-liner ci-dessous, ou récupéré et piloté à la main avec `--root`.

## Installation en une ligne

```bash
curl -fsSL https://caesar.koumalabs.org/install | sh
```

Le script vérifie les prérequis (git, Node ≥ 22, pnpm ou corepack), clone le dépôt dans `~/.local/share/caesar`, construit la CLI, et écrit un lanceur `caesar` dans `~/.local/bin` — après quoi `caesar <commande>` fonctionne depuis n'importe quel projet de votre machine, sans `--root`. Relancez-le à tout moment pour mettre à jour : mêmes répertoires, `git pull`, rebuild.

Deux variables d'environnement remplacent les emplacements : `CAESAR_INSTALL_DIR` (le checkout) et `CAESAR_BIN_DIR` (le lanceur). Le script refuse de mettre à jour par-dessus des modifications locales du checkout plutôt que de les écraser.

## Prérequis

- Node ≥ 22 (développé sous Node 24).
- pnpm.
- Au moins une CLI d'agent prise en charge sur le `PATH` (Codex, Antigravity, OpenCode, Copilot, ou Claude Code) — caesar lui délègue, il ne l'embarque pas.
- Bun, seulement si vous prévoyez d'utiliser la TUI de configuration (`caesar config`) ou de construire le binaire autonome — le reste de la CLI tourne sur Node seul.

## Checkout et build

```bash
pnpm install
pnpm exec tsc -b        # builds all packages
```

## Initialiser un projet

```bash
pnpm run caesar init   --root <path-to-your-project>   # creates <project>/.caesar/config.toml + the system prompts + deposits the skill and commands for detected runtimes
pnpm run caesar doctor --root <path-to-your-project>   # which agents are installed, with which capabilities, allowed or not
```

`pnpm run caesar <command>` est le script `caesar` du `package.json` racine de ce dépôt : il s'exécute depuis ici, jamais depuis le projet cible — d'où `--root <path-to-your-project>` pour lui indiquer où agir.

:::note Pas publié sur npm
Il n'y a pas de `npm install -g caesar` aujourd'hui. Chaque commande ci-dessus s'exécute depuis un checkout du dépôt via `pnpm run caesar <command> --root <path>`. Une fois le binaire `caesar` déclaré dans `packages/cli/package.json` publié, ou lié dans vos propres projets par les moyens pnpm habituels, `caesar <command>` fonctionne directement sur le `PATH` — plus besoin de `--root`, `resolveRoot` remonte alors automatiquement jusqu'au premier `.caesar/` ou `.git/` trouvé depuis le répertoire courant.
:::

`caesar doctor` inspecte le catalogue des agents et le recoupe avec la policy effective. Exemple réel, sur une machine où les cinq agents sont installés :

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

`allowed` s'affiche en vert et `denied` en rouge — les couleurs classifient, elles ne portent jamais l'information à elles seules ; `--verbose` ajoute le chemin du binaire et les capacités détaillées en entier.

Chaque commande accepte `--root <dir>` (racine de projet explicite ; par défaut, recherche automatique de `.caesar/` ou `.git/` en remontant depuis le répertoire courant). La plupart acceptent aussi `--json` pour une sortie machine — deux exceptions : `caesar mcp serve` ne le connaît pas du tout, et `caesar config` le refuse explicitement puisque c'est une TUI interactive qui n'a rien de lisible par machine à produire.

## Binaire autonome

caesar se construit aussi en un binaire unique sans Node, sans Bun, et sans `node_modules` requis sur la machine cible. Voir [Binaire autonome](../reference/binary.md) pour savoir comment le construire et l'exécuter.

## Prochaines étapes

- [Démarrage rapide](./quickstart.md) — votre premier aller-retour déléguer → diff → apply.
