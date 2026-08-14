---
title: Introduction
sidebar_position: 1
slug: /intro
description: caesar permet à un agent de code de déléguer des tâches à des CLI d'agents externes, isolées sur des worktrees jetables et réconciliées avec le diff Git.
---

{/* Source: README.md — manual resync */}

# Introduction

caesar est un orchestrateur qui permet à un agent de code — typiquement Claude Code — de déléguer des tâches à des sous-agents **externes** (Codex, Antigravity, OpenCode, Copilot, ou même une autre instance de Claude Code) exécutés comme de simples processus CLI, exactement comme il déléguerait à un sous-agent natif.

Le problème qu'il résout : chaque CLI d'agent de code a sa propre façon de recevoir une mission, de renvoyer un rapport, et de signaler qu'elle a besoin d'une clarification. Sans couche commune, comparer deux providers sur la même tâche — ou simplement rendre fiable un aller-retour avec l'un d'eux — signifie réapprendre son format à chaque fois, et le croire sur parole quant à ce qu'il prétend avoir modifié. caesar normalise ce cycle.

Il se présente sous la forme d'une CLI (`caesar`), d'un serveur MCP à dix outils pour tout piloter depuis Claude Code (ou tout autre client MCP), d'une TUI de configuration, et d'une skill multi-runtime à cinq commandes qui apprend à l'agent principal comment diriger caesar plutôt que d'exécuter le travail lui-même.

## Les trois piliers

1. **Un standard de communication commun, sans SDK requis.** OACP (Orchestrator–Agent Contract Protocol) est un contrat simple basé sur des fichiers — un répertoire de tâche, des variables d'environnement, des fichiers JSON — que n'importe quelle CLI peut parler en lisant et en écrivant des fichiers, qu'elle ait été conçue avec caesar en tête ou non.
2. **Un moteur qui isole chaque tâche sur un worktree Git jetable.** Rien ne touche le dépôt principal tant que vous n'en avez pas décidé ainsi : `caesar diff` montre ce qui a changé, `caesar apply` l'intègre.
3. **Une réconciliation systématique entre ce que l'agent déclare et ce que `git diff` observe.** Le diff est la source de vérité, jamais la seule parole de l'agent.

## Ce que vous gagnez réellement

| Axe | Sans caesar | Avec caesar |
|---|---|---|
| **Temps** | Un seul agent à la fois dans votre arbre de travail ; les particularités de chaque CLI réapprises à la main. | N tâches en parallèle (`max_parallel`, emplacements partagés entre processus), un seul flux pour cinq providers. Un atelier en copy-on-write est prêt en quelques secondes — un `node_modules` de 975 Mo se clone en 6,3 s et 11 Mo de disque, contre 15,0 s et 994 Mo pour une copie ordinaire. |
| **Risque** | L'agent écrit directement dans le dépôt, et vous devez croire son rapport sur parole. | Un worktree jetable ; rien n'atteint le dépôt avant un `caesar diff` puis `caesar apply` explicite ; les changements sont vérifiés au regard de git, pas simplement déclarés ; l'écriture in-place est refusée par défaut. |
| **Coût et flexibilité** | Enfermé dans l'outil ou l'abonnement d'un seul provider. | Puisez dans les quotas de plusieurs providers depuis un seul orchestrateur, choisissez un modèle par tâche ou par rôle (`[models]`, `role.model`), et mettez les providers en concurrence sur le même objectif (`/caesar-race`) pour ne garder que le meilleur diff. |

## Agents pris en charge

| Agent | Identifiant | Mode headless | Réseau |
|---|---|---|---|
| Codex | `codex` | `codex exec --json -s <read-only\|workspace-write> …` | mode écriture uniquement |
| Antigravity CLI | `antigravity` | `agy --print <prompt> --output-format stream-json --mode <plan\|accept-edits> …` | ouvert |
| OpenCode | `opencode` | `opencode run --format json --dir <workspace> …` | ouvert |
| GitHub Copilot CLI | `copilot` | `copilot --prompt <prompt> --output-format json --no-color --log-level none …` | contrôlable |
| Claude Code | `claude` | `claude --print <prompt> --output-format stream-json --verbose --permission-mode <plan\|acceptEdits> …` | ouvert |

`claude` figure dans le catalogue — déléguer d'une instance de Claude Code à une autre a du sens, pour une revue croisée par exemple — mais il est refusé par défaut (`allow_recursion: false`) précisément parce que c'est le cas le plus susceptible de boucler. Lever ce refus est explicite : en activant l'agent ou en l'autorisant dans la policy.

## Où aller ensuite

- [Installation](./getting-started/installation.md) — prérequis et première configuration.
- [Démarrage rapide](./getting-started/quickstart.md) — un aller-retour complet déléguer → diff → apply.
- [Le standard OACP](./protocol/overview.md) — le contrat basé sur les fichiers derrière chaque délégation.
