---
title: Utiliser caesar depuis Claude Code
sidebar_position: 5
description: Enregistrez caesar comme serveur MCP pour Claude Code et laissez la skill et les commandes déposées diriger les délégations pour vous.
---

{/* Source: README.md, .claude/skills/caesar/SKILL.md, .claude/commands/caesar-delegate.md, .claude/commands/caesar-fanout.md, .claude/commands/caesar-race.md, .claude/commands/caesar-review.md, .claude/commands/caesar-tasks.md — manual resync */}

# Utiliser caesar depuis Claude Code

Enregistrez le serveur MCP auprès de Claude Code :

```bash
caesar mcp install claude --root <your-project>
# runs: claude mcp add caesar -- caesar mcp serve --root <your-project>
```

`caesar mcp install` fonctionne aussi avec `codex`, `copilot`, `opencode` et `antigravity` (installation via une sous-commande native pour `claude`/`codex`, via un fichier de configuration fusionné pour les trois autres — `--dry-run` montre ce qui serait fait sans rien exécuter ni écrire). Une fois enregistré, Claude Code expose dix outils préfixés `mcp__caesar__` ; le détail complet de chacun vit dans la [référence des outils MCP](../reference/mcp-tools.md).

| Outil | Ce qu'il fait |
|---|---|
| `caesar_delegate` | Démarre une tâche sur un agent externe et renvoie immédiatement un identifiant de tâche. |
| `caesar_await` | Attend une ou plusieurs tâches et récupère leurs résultats. |
| `caesar_status` | Un contrôle non bloquant et peu coûteux de l'état actuel d'une tâche. |
| `caesar_logs` | Les événements normalisés d'une tâche, utile quand un résultat semble incorrect. |
| `caesar_cancel` | Arrête une tâche manuellement. |
| `caesar_diff` | Le diff produit par une tâche, avant toute application. |
| `caesar_apply` | Intègre le diff d'une tâche dans le dépôt principal. |
| `caesar_list_agents` | Quels providers sont installés et autorisés en ce moment. |
| `caesar_list_roles` | Les rôles configurés, leurs chaînes de repli, et vers quel agent chacun résout aujourd'hui. |
| `caesar_answer` | Répond à une question qu'un sous-agent a posée via le canal retour. |

## Le savoir agentique : skill et commandes

Ce qui rend une délégation aussi naturelle qu'invoquer un sous-agent natif, ce n'est pas ces dix outils pris isolément : c'est la skill `caesar`, déposée par `caesar init` auprès de l'agent principal, qui lui apprend à les utiliser.

**Diriger, pas exécuter.** La skill apprend à l'agent principal à briefer un exécutant externe pour une tâche précise, à en lancer plusieurs à la fois sans attendre que l'un démarre avant l'autre, et à ne jamais prendre ce qui revient pour argent comptant : c'est le diff qui décide, pas le résumé du sous-agent.

Cinq commandes en découlent directement, une par geste :

| Commande | Ce qu'elle fait |
|---|---|
| `/caesar-delegate` | Fait implémenter quelque chose par un agent de code externe sur un worktree jetable, puis présente son rapport et son diff pour revue. |
| `/caesar-fanout` | Découpe un travail en objectifs indépendants, les délègue tous à la fois à des agents de code externes, et présente chaque diff séparément. |
| `/caesar-race` | Exécute le même objectif sur plusieurs agents de code externes en parallèle et pose leurs propositions concurrentes côte à côte, sans en choisir une. |
| `/caesar-review` | Fait relire un diff ou un morceau de code, en lecture seule, par un agent de code externe autre que celui qui l'a écrit, avec des constats classés par sévérité. |
| `/caesar-tasks` | Rapporte l'état des tâches déléguées — ce qui tourne, ce qui est terminé, ce qui est bloqué — et annule ce qui doit mourir. |

Dans un runtime où la skill est déposée, il suffit de demander — *« délègue l'implémentation de X à Codex »* — et l'agent principal est guidé lui-même à travers la séquence `caesar_delegate` → `caesar_await` → rapport-et-diff, sans bloquer la conversation pendant que l'agent externe s'exécute. Sous Claude Code, les cinq commandes ci-dessus donnent cette même séquence explicitement, sans dépendre du déclenchement automatique de la skill.

`caesar init` détecte les runtimes présents sur le `PATH` et dépose (ou rafraîchit) la skill et les commandes pour eux ; relancer `caesar init` sans `--force` sur un projet déjà initialisé ne rafraîchit que la skill et les commandes — `.caesar/config.toml` et les rôles, que vous éditez à la main, restent intacts.

## Prochaines étapes

- [Déléguer des tâches](./delegating.md) — comment rédiger un brief que la discipline de la skill attend.
- [Le standard OACP](../protocol/overview.md) — le contrat basé sur les fichiers sous-jacent à chacun de ces outils.
