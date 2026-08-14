---
title: TUI
sidebar_position: 4
description: caesar config, la TUI de configuration interactive — navigation, portée d'édition, et ce que chacun de ses cinq écrans édite.
---

{/* Source: README.md §Configuration interface, packages/tui/src/App.tsx, packages/tui/src/screens/AgentsScreen.tsx, packages/tui/src/screens/RolesScreen.tsx, packages/tui/src/screens/PolicyScreen.tsx, packages/tui/src/screens/IntegrationsScreen.tsx, packages/tui/src/screens/PromptEditor.tsx — manual resync */}

# TUI

Éditer policy, rôles, agents et intégrations MCP de façon interactive, c'est à ça que sert `caesar config` — une interface OpenTUI-et-React avec une seule exigence dure : Bun, pas Node. Le rendu d'OpenTUI passe par la FFI de Bun, et Node 24 n'a aucun équivalent à lui offrir.

:::warning Nécessite Bun
Sans `bun` sur le PATH, `caesar config` explique la situation et pointe vers les sous-commandes équivalentes plutôt que d'échouer sèchement :

```
$ caesar config
The configuration TUI requires Bun: OpenTUI renders through its FFI, which Node 24 does not allow […]. "bun" was not found in the PATH.
Install Bun (https://bun.sh), or use the equivalent subcommands:
  - caesar policy show   Effective policy (allow/deny, provenance).
  - caesar role list     Roles, fallback agents, the agent picked today.
  - caesar agents list   Agent catalog: presence, capabilities, authorization.
```
:::

Aucun de ces points d'entrée — la TUI, les sous-commandes mentionnées ci-dessus, ou le serveur MCP — ne lit ni n'écrit la configuration pour son propre compte. Ce sont tous des façades sur le même `@caesar/core`, qui seul fusionne les trois couches décrites dans [Configuration](./configuration.md) et reste la source de vérité unique tout du long.

## Navigation

- `Tab` / `Shift-Tab`, ou `1`-`4` — changer d'écran.
- `s` — sauvegarder les changements en attente sur la couche active. Rien n'est écrit sur disque avant cela, sauf l'éditeur de system prompt, qui écrit sur `Ctrl+S`.
- `p` — faire défiler la portée d'édition : global → projet → local. Changer de portée avec des changements en attente demande confirmation avant de les abandonner.
- `?` — afficher l'aide en surimpression.
- `q` ou `Ctrl+C` — quitter, avec confirmation si des changements sont en attente.

La portée active reste visible en permanence, avec le chemin de fichier que `s` écrira — savoir « couche projet » ne dit pas *où* ça se trouve, et c'est précisément ce qu'on veut vérifier avant de sauvegarder.

## Agents

Un tableau de catalogue (présence, permission, capacités) avec le détail de l'agent sélectionné en dessous : présence, version, capacités, permission, les rôles qui l'emploient, et — pour un agent **déclaré** (`[[agent]]`) — ses champs éditables (nom d'affichage, binaire, arguments, arguments réseau, mode de répertoire, lecture seule native).

- `↑↓` — choisir un agent.
- `Space` — autoriser / refuser (écrit la liste de policy ; `denied` l'emporte toujours).
- `m` — le modèle par défaut de l'agent, agents natifs compris (la table `[models]`).
- `n` — déclarer une CLI que le catalogue natif ne connaît pas : l'identifiant se tape en ligne, puis `bin`/`args` et le reste s'affinent dans le panneau de détail.
- `x` — retirer une déclaration.
- `Enter` — éditer les champs d'un agent déclaré.

Autoriser et déclarer sont deux gestes différents : le premier écrit une liste de policy, le second ajoute un agent au catalogue — les confondre est la méprise la plus facile sur cet écran.

## Roles

La liste des rôles à gauche, l'édition du rôle sélectionné à droite : nom, intention, agents dans leur ordre de repli, mode, isolation, network, modèle, timeout, et le system prompt lui-même — contenu compris, pas seulement son chemin.

- `↑↓` — choisir un rôle ; `n` en crée un, `x` le supprime (renommer et supprimer restent réservés à un rôle que la couche active déclare elle-même).
- Sur un champ, `Enter` l'édite, ou le fait défiler pour `mode`/`isolation`/`network`.
- Sur « Agents » : `Enter` ouvre l'ordre de repli ; `Shift+J`/`Shift+K` déplace l'agent sélectionné, `a` en ajoute un, `r` en retire un. L'agent que `caesar_delegate` choisirait aujourd'hui est marqué « ← picked ».
- Sur « Model » : le modèle demandé à l'agent qui sera choisi, quel qu'il soit — prime sur la valeur par défaut de `[models]`, perd face à un `--model`/`model:` explicite. Vide signifie la valeur par défaut propre à l'agent.
- Sur « System prompt » : `Enter` ouvre l'éditeur de prompt plein écran (ci-dessous) ; `f` change le chemin de fichier déclaré.

## Policy

Les champs de `[policy]` en langage clair plutôt qu'en clés TOML brutes — chacun porte un libellé, et la clé TOML à laquelle il correspond s'affiche une fois sélectionné, pour qui édite aussi le fichier à la main. Une valeur héritée d'une couche moins spécifique est marquée (`← global`).

- `↑↓` — choisir un réglage ; `Enter` l'édite, ou ouvre la liste `allowed`/`denied`.
- Dans une liste : `a` ajoute un agent, `r` en retire un, `Esc` retourne aux réglages.

L'écran garde un rappel permanent affiché : **`denied` l'emporte toujours sur `allowed`** — un agent présent dans les deux est refusé.

## Integrations

Pour chacun des cinq clients MCP (`claude`, `codex`, `copilot`, `opencode`, `antigravity`) : son statut d'enregistrement du serveur `caesar` (enregistré / non enregistré / non vérifiable — `claude` et `codex` n'ont aucune lecture de statut fiable et sans effet de bord) et, dans le panneau de détail, un aperçu de ce que `Enter` fera réellement avant de l'exécuter — la commande qui s'exécuterait, ou le fichier qui serait fusionné et sous quelle clé, avec le reste de ce fichier préservé. C'est le seul écran qui écrit en dehors du projet, dans la configuration propre du client ; l'aperçu existe pour que cela ne soit jamais une surprise.

- `↑↓` — choisir un client ; `Enter` installe ou met à jour l'enregistrement.

## Éditeur de prompt

Un éditeur plein écran pour le system prompt d'un rôle — le texte placé en tête du contexte passé à l'agent, avant l'objectif de la tâche. Ouvert depuis l'écran Roles (« System prompt », `Enter`).

Deux choses le distinguent du reste de la TUI :

- **Il écrit immédiatement.** `Ctrl+S` sauvegarde le fichier directement, en dehors du mécanisme global `s`/portée — un prompt est un fichier unique, pas un réglage à trois couches.
- **Il nomme le fichier que le moteur lira réellement**, son chemin absolu affiché en haut — un rôle venant de la couche globale résout son prompt dans le projet *courant*, jamais un fichier partagé entre projets.

`Esc` abandonne l'édition, en demandant d'abord confirmation si le texte a changé.

## Prochaines étapes

- [Configuration](./configuration.md) — la référence complète de `[policy]`, `[[role]]`, `[[agent]]`, `[models]` que cette TUI édite.
- [Utiliser caesar depuis Claude Code](../guides/claude-code.md) — enregistrer le serveur MCP, l'une des choses que fait Integrations.
