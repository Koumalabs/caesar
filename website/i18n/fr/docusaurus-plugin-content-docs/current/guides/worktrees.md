---
title: "L'atelier : les worktrees"
sidebar_position: 2
description: Comment caesar isole chaque tâche sur un worktree git jetable, pourquoi le copy-on-write le rend bon marché, et pourquoi l'écriture in-place est refusée par défaut.
---

{/* Source: README.md — manual resync */}

# L'atelier : les worktrees

Un worktree git ne contient que les fichiers **suivis**. Les dépendances installées, le `.env`, les répertoires ignorés portant des briefs ou des artefacts n'y sont pas : rien ne s'y installe, rien ne s'y exécute, rien ne peut y être vérifié. Sur un projet réel, l'isolation peut devenir un espace vide où il n'y a rien à faire — le correctif consiste à compléter l'atelier, jamais à contourner l'isolation.

## Compléter l'atelier

La section `[worktree]` de `.caesar/config.toml` décrit ce qui doit être apporté pour que le worktree devienne un endroit où l'on peut réellement travailler :

```toml
[worktree]
copy  = ["node_modules", ".env"]   # copied — isolated from the workspace
link  = []                         # linked — shared, hence not isolated
setup = ["pnpm install --offline"] # run in the worktree, before the agent
```

`caesar init` la remplit à partir de ce qu'il trouve (`pnpm-lock.yaml`, `Cargo.toml`, `pyproject.toml`, `.env`…), et n'écrit rien s'il ne trouve rien.

**`copy` plutôt que `link`.** Sur un système de fichiers copy-on-write — APFS, Btrfs, XFS — la copie se fait par clonage, et ne duplique rien tant que personne n'écrit. Mesuré sur un `node_modules` de 975 Mo (~100 000 fichiers) : **6,3 s et 11 Mo de disque**, contre 15,0 s et 994 Mo pour une copie ordinaire. Ce n'est pas gratuit — le parcours de l'arbre doit tout de même avoir lieu — mais c'est le prix d'une isolation réelle, et cela reste favorable face au coût de l'étape `setup` que cela évite de relancer. La copie reste une véritable copie du point de vue de l'agent : deux tâches simultanées ne partagent rien, et ce que l'une casse chez elle ne casse rien ailleurs.

`link` existe pour les systèmes de fichiers sans copy-on-write, mais partage le répertoire avec l'espace de travail — le rapport de la tâche le dit en toutes lettres.

Ce que caesar lui-même a mis en place est retiré du diff : un `.env` copié n'apparaît ni dans `caesar diff` ni dans `caesar apply`. Et un chemin déclaré qui ne peut pas être mis en place — suivi par git, non ignoré, absent — produit un constat nommant la clé à corriger, plutôt qu'une tâche qui échoue sans raison visible.

## L'écriture in-place est refusée par défaut

Une tâche d'**écriture** qui demande `--isolation inplace` dans un dépôt git utilisable est refusée, en nommant le remède. Ce n'est pas une précaution abstraite : c'est la règle dont l'absence l'a rendue nécessaire — un sous-agent écrivant directement sur la branche de travail de l'utilisateur est exactement ce que l'isolation par worktree existe pour empêcher.

:::warning Si le worktree semble incomplet
La réponse consiste à compléter `[worktree]`, jamais `--isolation inplace`. Pour les dépôts où ce mélange est accepté en connaissance de cause, `allow_inplace_write = true` sous `[policy]` lève l'interdiction — et deux tâches d'écriture ne peuvent toujours pas partager le même arbre en même temps, puisque leurs diffs deviendraient impossibles à attribuer.
:::

En dehors d'un dépôt git, ou dans un dépôt sans le moindre commit, aucun worktree n'est possible : `inplace` y reste le seul mode de fonctionnement, et rien n'est refusé.

## Prochaines étapes

- [Tâches parallèles](./parallel.md) — chaque tâche a son propre atelier ; voici comment plusieurs s'exécutent à la fois.
- [Configuration](../reference/configuration.md) — la référence complète de `[worktree]` et `[policy]`.
