---
title: Observer les sous-agents
sidebar_position: 4
description: caesar watch ouvre une fenêtre en direct, sans démon, sur ce que font les tâches déléguées, sans rien modifier.
---

{/* Source: README.md — manual resync */}

# Observer les sous-agents

Une tâche déléguée n'est pas une boîte noire : `caesar watch` ouvre une fenêtre sur ce qui se passe, à côté de la conversation ou du terminal qui a lancé la délégation.

```bash
caesar watch                 # all running tasks, redrawn frame
caesar watch t_a1b2 t_c3d4   # only these
caesar watch --once          # one frame, then exit
caesar watch --json          # NDJSON of the events, several tasks merged
```

```
▞▚ caesar · watch   1 active · max_parallel 4                             17:21:20

● t_efb5914d codex        —            25s  inplace · write
  Write three files a.txt, b.txt and c.txt, then run 'sleep 8 && ls -1'…
  ▸ shell /bin/zsh -lc 'sleep 8 && ls -1' — 3s
  ~ 3 file(s)  ·  11 event(s)

q or Ctrl-C to quit — watching modifies nothing.
```

Aucun démon n'est nécessaire : le moteur écrit `events.jsonl` **pendant** l'exécution et publie l'état des tâches par écritures atomiques. `caesar watch` se contente de lire ce qu'un autre processus écrit — la même propriété qui fait fonctionner `caesar cancel` et le partage de `max_parallel`.

## Quatre choix de conception délibérés

- **Un outil apparaît dès qu'il démarre**, pas à sa fin. C'est toute la différence entre voir un `npm install` de trois minutes se déclencher et le découvrir à la troisième minute.
- **Le silence s'affiche.** Une tâche bloquée et une tâche en train de travailler sont indiscernables sans cela ; passé trente secondes sans le moindre événement, la vue le signale.
- **Une question en attente passe devant tout le reste.** Un sous-agent attendant une réponse sur le canal retour ressemble exactement à un sous-agent gelé.
- **Les tâches terminées restent visibles** pendant quelques minutes, avec le statut de leur rapport : une tâche qui disparaît au moment où elle se termine est une tâche dont vous ne connaîtrez jamais la fin.

En dehors d'un terminal (redirection, `| tee`, script), pas de redessin ni de séquences ANSI : une ligne par événement, et `--json` produit du NDJSON exploitable.

## Ce que chaque agent laisse voir

Ce que vous pouvez observer pendant l'exécution dépend de ce que chaque CLI narre, et cela varie beaucoup :

| Agent | Pendant l'exécution |
|---|---|
| `codex` | début **et** fin de chaque commande, fichiers modifiés, ses rapports de progression |
| `claude` | outils, résultats, texte, et un signal de réflexion en cours |
| `opencode` | outils (seulement une fois terminés — son flux n'annonce pas leur début), texte |
| `antigravity` | son texte au fil de l'eau, ses erreurs ; ses appels d'outils ne sont pas encore traduits |
| `copilot` | texte, erreurs de session ; ses appels d'outils restent non vérifiés faute de quota disponible |

Ces traductions sont écrites à partir de captures réelles et rejouées par des tests. Là où une forme n'a pas pu être observée, l'adaptateur le dit en toutes lettres plutôt que de deviner.

:::note Vue interactive — pas pour le scripting
`caesar watch` sans `--once` redessine et ne se termine jamais de lui-même ; il est pensé pour un humain devant un terminal. Pour un instantané unique dans un script ou un flux automatisé, utilisez plutôt `caesar watch --once` ou `caesar ps`.
:::

Autres sous-commandes utiles pour suivre des délégations : `caesar ps` (tâches en cours et récentes), `caesar logs <id> [--raw] [--follow]`, et `caesar cancel <id>`. Voir la [référence CLI](../reference/cli.md) pour la liste complète.

## Prochaines étapes

- [Déléguer des tâches](./delegating.md) — les groupes de commandes, y compris ceux pour suivre les tâches.
- [Utiliser caesar depuis Claude Code](./claude-code.md) — les équivalents MCP de l'observation et du suivi.
