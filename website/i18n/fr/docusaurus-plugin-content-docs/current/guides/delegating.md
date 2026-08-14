---
title: Déléguer des tâches
sidebar_position: 1
description: Les groupes de commandes offerts par caesar, et comment rédiger un brief qu'un sous-agent peut réellement exécuter.
---

{/* Source: README.md, .claude/skills/caesar/SKILL.md — manual resync */}

# Déléguer des tâches

## Diriger, pas exécuter

Les outils de délégation — `caesar_delegate`, `caesar_await`, `caesar_status`, `caesar_logs`, `caesar_diff`, `caesar_apply`, `caesar_cancel`, `caesar_answer`, `caesar_list_agents`, `caesar_list_roles` — exécutent des CLI d'agents de code comme des processus séparés. Tout ce qu'un diff git peut trancher revient à un sous-agent : une implémentation mécanique, une large lecture de code, un changement répétitif étalé sur de nombreux fichiers. Ce qui reste à l'agent principal, c'est la part qu'aucun diff ne peut vérifier — découper le travail, le briefer, arbitrer ce qui revient, décider ce qui entre dans le dépôt.

La posture n'est donc pas « faire le travail, et déléguer ce qui reste ». C'est l'inverse : énoncer l'objectif avec assez de précision pour que quelqu'un d'autre puisse l'exécuter, puis juger le résultat. Si l'objectif ne peut pas être énoncé avec cette précision, c'est cela le travail — et il reste à l'agent principal.

### Ce qui sort, ce qui reste

Déléguer quand :

- l'objectif est **vérifiable** — des tests, un build, ou un diff qui peut se lire au regard de critères écrits avant qu'il n'existe ;
- le travail est large mais superficiel : faire passer un paramètre à travers une chaîne d'appels, aligner plusieurs adaptateurs sur un motif déjà établi par l'un d'eux, porter une convention à travers des packages ;
- le travail est une large lecture : cartographier un sous-système, trouver tous les appelants d'un comportement, expliquer un mécanisme (utiliser le mode lecture seule — rien n'a besoin d'être écrit pour répondre à une question) ;
- un avis extérieur vaut mieux qu'une nouvelle passe de votre part : un provider qui n'a pas écrit le diff voit ce que son auteur ne peut structurellement pas voir ;
- deux morceaux du travail ou plus touchent des fichiers disjoints et peuvent s'exécuter en même temps.

Garder quand :

- un correctif de trois lignes ne vaut pas un aller-retour de délégation — le seuil n'est pas le nombre de lignes mais le coût du brief : si décrire le changement prend plus longtemps que le faire, faites-le ;
- la décision *est* le travail : lequel de deux designs, faut-il casser une interface publique, ce qui a réellement été demandé ;
- l'objectif ne peut pas s'écrire sans la conversation qui l'entoure — un sous-agent reçoit le brief et rien d'autre, aucun historique, aucune hypothèse partagée ;
- le critère d'acceptation honnête serait « ça a l'air correct » — les objectifs invérifiables reviennent sous forme de prose confiante posée sur un diff sans aucune norme à laquelle le juger.

## Briefer un sous-agent

Un sous-agent est un processus séparé, sans accès à la conversation qui l'a fait naître. Rien de ce qui y a été dit, lu ou conclu ne l'atteint — quatre champs constituent tout le canal :

- **`objective`** — une instruction autonome, avec les vrais noms de fichiers et de symboles. Lisez le code d'abord, pour que l'objectif nomme ce qui existe réellement.
- **`context`** — ce que le sous-agent devrait sinon redécouvrir : le code pertinent recopié, ce qui a déjà été tenté et comment ça a échoué, l'invariant qui n'est pas évident depuis le fichier qu'il va éditer.
- **`constraints`** — les interdits et obligations qu'un agent compétent se tromperait sinon à deviner : ne pas toucher à l'interface publique, aucune nouvelle dépendance, conserver les noms de tests existants.
- **`acceptance_criteria`** — le champ qui rend le contrôle possible ensuite. Écrivez des critères qu'un tiers pourrait vérifier sans poser de question : une commande de test qui doit passer, un périmètre à ne pas dépasser. Des critères vagues sont pires que pas de critères du tout — ils laissent le propre résumé du sous-agent tenir lieu de preuve.

## Les groupes de commandes

`caesar --help` regroupe ses seize commandes par usage plutôt que de les lister dans l'ordre de déclaration ; `caesar <command> --help` donne le détail de chacune. Les flags complets et les codes de sortie vivent dans la [référence CLI](../reference/cli.md).

**Prise en main**
- `caesar init` — crée `.caesar/config.toml`, les system prompts par défaut, et dépose la skill et les commandes pour les runtimes qu'il détecte.
- `caesar doctor` — rapporte quels agents sont installés, avec quelles capacités, autorisés ou non par la policy effective.

**Déléguer**
- `caesar run` — l'aller-retour complet : délègue, attend, renvoie le rapport.
- `caesar diff <id>` — montre ce qu'une tâche a changé, avant que quoi que ce soit n'atteigne le dépôt principal.
- `caesar apply <id>` — intègre le worktree d'une tâche dans le dépôt principal.
- `caesar cancel <id>` — arrête une tâche manuellement.

**Suivre**
- `caesar watch` — une vue en direct des tâches en cours, redessinée au fil des événements.
- `caesar ps` — les tâches en cours plus les plus récemment terminées.
- `caesar logs <id>` — les événements normalisés d'une tâche (`--raw` pour la sortie brute du provider, `--follow` pour suivre en continu).
- `caesar gc` — réconcilie les tâches dont le processus est mort sans écrire de statut final, et collecte les worktrees déjà appliqués.

**Configurer**
- `caesar agents list|enable|disable|test` — le catalogue d'agents : présence, capacités, autorisation.
- `caesar policy show|allow|deny` — la policy effective et qui peut s'exécuter.
- `caesar role list|show|add|remove` — les rôles, leur chaîne de repli, et l'agent vers lequel un rôle résout aujourd'hui.
- `caesar config` — une TUI interactive (nécessite Bun) pour éditer la policy, les rôles et les intégrations MCP.

**Intégrer**
- `caesar mcp install <client>` / `caesar mcp serve` — enregistre caesar comme serveur MCP pour un client, ou sert le protocole sur stdout.
- `caesar protocol schema <task|report|event>` — publie le standard OACP sous forme de JSON Schema.

## Prochaines étapes

- [L'atelier : les worktrees](./worktrees.md) — comment l'isolation fonctionne réellement.
- [Tâches parallèles](./parallel.md) — exécuter plusieurs délégations à la fois.
- [Observer les sous-agents](./watch.md) — suivre une délégation en direct.
