---
title: Tâches parallèles
sidebar_position: 3
description: Comment caesar plafonne et partage les délégations concurrentes entre processus, et comment il récupère les emplacements laissés par des processus tués.
---

{/* Source: README.md, .claude/skills/caesar/SKILL.md — manual resync */}

# Tâches parallèles

Plusieurs agents s'exécutent à la fois, chacun dans son propre atelier (`.caesar/wt/<taskId>`, sur une branche nommée pour être lisible — `caesar/<role>/<objective>-<8 chars>`). C'est le mode normal depuis Claude Code : `caesar_delegate` rend immédiatement la main avec un `task_id`, vous en lancez plusieurs, `caesar_await` récupère les résultats.

## Une limite partagée entre processus

`policy.max_parallel` (4 par défaut) plafonne l'ensemble — **entre processus inclus**. Six invocations de `caesar run` dans six terminaux, plus une conversation Claude Code qui délègue : tous partagent les mêmes emplacements, matérialisés comme des fichiers sous `.caesar/state/slots/`. Un `caesar run` qui ne trouve pas de place attend en le disant, et nomme qui occupe les emplacements :

```
$ caesar run --agent codex "…"
1 task(s) already running under this project (max_parallel = 1) — waiting for a slot. Ctrl-C to give up.
  · pid 51820 — caesar run — review the parser (since 2026-08-11T13:42:11.004Z)
```

## Récupérer les emplacements morts

Un processus tué (`kill -9`) laisse son fichier d'emplacement derrière lui : le premier appelant qui trouve tout occupé vérifie chaque détenteur et récupère ceux dont le processus n'existe plus. Une limite qui pourrait devenir un blocage permanent serait pire que pas de limite du tout.

Cela laisse aussi sa tâche en suspens. Le statut d'une tâche est écrit par le processus qui la conduit : tué — `kill -9`, session MCP fermée, machine éteinte — il ne l'écrit jamais, et l'enregistrement reste « running » indéfiniment. `caesar ps` et `caesar gc` réconcilient cet état : une tâche dont le marqueur nomme un processus disparu passe à failed, avec un rapport qui dit ce qui s'est passé, et le worktree qu'elle détenait redevient collectable. La preuve est positive — un pid qu'on ne retrouve plus — jamais déduite d'une absence : une tâche sans marqueur n'est jamais conclue par défaut, et `caesar cancel <id>` reste la voie de sortie manuelle.

:::note Deux mises en garde
L'attente est un scrutin, pas une file : entre deux candidats, l'ordre d'entrée n'est pas garanti. Et récupérer un emplacement mort repose sur le pid, ce qui n'a de sens que sur une seule machine — un répertoire `.caesar/` sur un partage réseau, utilisé depuis deux postes, verrait les emplacements de l'autre comme vivants indéfiniment.
:::

## Diriger plusieurs tâches à la fois

Les délégations ne bloquent pas. Lancer plusieurs tâches et les récupérer ensemble est la partie la plus précieuse de cet outillage, et cela se présente sous deux formes :

- **Fan-out** — des objectifs *différents* à la fois, parce qu'ils sont indépendants : cinq adaptateurs à aligner, quatre packages à migrer, trois documents à régénérer depuis une même source.
- **Race** — *le même* objectif sur plusieurs providers, pour obtenir des propositions concurrentes, quand l'approche elle-même est incertaine et mérite d'être vue deux fois.

Avant de lancer un lot, découpez pour une réelle indépendance : aucun fichier n'apparaît dans deux objectifs, aucune tâche n'a besoin de la sortie d'une autre, aucune tâche ne déplace, renomme ou supprime quelque chose qu'une autre lit. Si deux morceaux partagent un fichier, fusionnez-les en un seul objectif ou exécutez-les en séquence — les diffs de tâches ayant touché le même fichier n'atterriront pas ensemble.

Dimensionnez le lot à `max_parallel` : dix objectifs contre une limite de quatre signifie six tâches en attente avant de démarrer. Découpez en lots que vous pouvez réellement tenir, ou déléguez par vagues. Et ne laissez jamais un traînard retenir le rapport — annulez un provider lent ou bloqué plutôt que de retarder ce que les autres ont déjà produit.

## Prochaines étapes

- [Observer les sous-agents](./watch.md) — suivre ce que font toutes ces tâches parallèles.
- [Déléguer des tâches](./delegating.md) — comment bien briefer un sous-agent.
