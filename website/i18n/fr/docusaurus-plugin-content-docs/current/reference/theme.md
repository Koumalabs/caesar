---
title: Thème
sidebar_position: 5
description: La palette de caesar — or d'accent, couleurs sémantiques, les deux règles qui les gouvernent, et comment les capacités d'un terminal sont détectées automatiquement.
---

{/* Source: README.md §The theme, packages/theme/src/palette.ts, packages/theme/src/ansi.ts, packages/theme/src/wordmark.ts — manual resync */}

# Thème

La CLI et la TUI puisent toutes deux dans une seule palette, définie à un seul endroit : `packages/theme`. Cette consolidation est récente — la CLI avait l'habitude d'utiliser celui des sept codes ANSI de base qui semblait convenir à chaque site d'appel, indépendamment des propres couleurs de la TUI, si bien que les deux interfaces d'un même outil finissaient par sembler sans rapport à l'écran.

## La palette

- **Accent** — `#EAA52E`, l'or de marque : focus, sélection, l'onglet actif. Assez saturé pour trancher, assez clair pour porter une encre sombre (`#1A1206`) partout où il devient un fond.
- **Ramp** — un dégradé à six nuances, une entrée par ligne du wordmark (le logo ASCII), chaque palier s'assombrissant depuis l'or de marque : `#EAA52E`, `#DB9A2B`, `#CC8F28`, `#BD8425`, `#AE7922`, `#9F6E1F`. Il ne fait jamais que s'assombrir, jamais s'éclaircir vers le blanc — un dégradé tendant vers le blanc disparaîtrait sur un terminal à fond clair, et beaucoup d'utilisateurs en font tourner un.
- **Secondaire (`DIM`)** — `#9E9284` : en-têtes de colonnes, valeurs par défaut, explications.
- **Tertiaire (`FAINT`)** — `#6B6252` : bordures inactives, marques d'héritage, ce qui ne doit se lire que si on le cherche.
- **Sémantique** — `OK` `#7DCE82`, `WARN` `#E0AF68`, `BAD` `#E88388` : `allowed`/`denied`, statuts de tâches, statuts de rapports.

Au niveau de profondeur de couleur le plus grossier (les 16 de base — voir ci-dessous), l'or de l'accent s'effondre sur le même jaune vif que `WARN` : le prix accepté d'un accent doré partageant une palette de terminal limitée avec une couleur d'avertissement. Le poids et le contexte les distinguent tout de même à l'écran.

## Deux règles

- **Le texte principal ne porte jamais de couleur.** Il hérite du premier plan du terminal, donc il reste lisible aussi bien sur fond clair que sombre. Seuls le secondaire, le tertiaire et le sémantique sont colorés. C'est pourquoi les paroles d'un sous-agent, dans `caesar run`, ressortent en texte neutre : c'est son badge qui est teinté, pas ce qu'il dit.
- **La couleur classe, elle ne décore pas.** Une valeur colorée est une valeur que votre œil va chercher sans la lire.

## Les trois canaux

| | Structure (cadres, bannières) | Couleur |
|---|---|---|
| `--json` | non | non |
| Hors d'un terminal (pipe, redirection, `\| tee`) | oui | non |
| Terminal | oui | oui |

`--json` reste strictement du JSON : aucune séquence ANSI, aucune bannière, rien d'autre sur `stdout`. C'est le canal par lequel un agent consomme cette CLI, et il ne bouge pas. Un tableau encadré, en revanche, se découpe mal sous `grep`/`awk` — c'est accepté, `--json` est fait pour ça.

## Ce qui s'adapte tout seul

- **Profondeur de couleur** — truecolor si `COLORTERM` l'annonce, sinon le 256 si `TERM` contient `256color`, sinon les 16 de base. Délibérément conservateur : une séquence 256 émise vers un terminal qui l'ignore s'affiche en clair au milieu du texte.
- **[`NO_COLOR`](https://no-color.org)** et `TERM=dumb` coupent toute couleur.
- **Locale non UTF-8** (`LC_ALL=C`) — les bordures et marques fines retombent sur un jeu ASCII de même largeur : `+--+`, `|`, `*`, `+`, `x`. Sans ce repli, un cadre Unicode sur un terminal qui ne peut pas le lire est moins lisible qu'un tableau sans cadre.
- **Largeur du terminal** — le coût du cadre (`3N+1` caractères pour N colonnes) entre dans le budget, afin qu'aucune bordure ne passe jamais à la ligne. Quand le cadre ne peut plus tenir, il est abandonné au profit d'une mise en page alignée, qui récupère l'espace qu'il coûtait.

## Prochaines étapes

- [TUI](./tui.md) — là où cette palette est la plus sollicitée : focus, sélection, marques d'héritage.
- [Référence CLI](./cli.md) — `--json` et les codes de sortie vers lesquels ce système de thème se replie hors d'un terminal.
