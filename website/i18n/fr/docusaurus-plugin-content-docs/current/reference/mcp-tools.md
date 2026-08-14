---
title: Outils MCP
sidebar_position: 3
description: Les dix outils mcp__caesar__ — ce que fait chacun, ses principaux paramètres, et ce qu'il retourne — plus le canal retour injecté dans les sous-agents.
---

{/* Source: packages/mcp-server/src/tools/delegate.ts, await.ts, status.ts, logs.ts, cancel.ts, diff.ts, apply.ts, list-agents.ts, list-roles.ts, answer.ts, packages/mcp-channel/src/server.ts — manual resync */}

# Outils MCP

Une fois que `caesar mcp install` a enregistré le serveur auprès d'un client, il expose dix outils préfixés `mcp__caesar__`. Ce sont deux façades sur le même moteur que la CLI : un sous-agent natif (Claude Code, ou tout autre client MCP) pilote les délégations via ces appels plutôt qu'en exécutant `caesar run` en sous-processus.

### `caesar_delegate`

Démarre un objectif sur un sous-agent (`codex`, `antigravity`, `opencode`, `copilot`, ou `claude`) exécuté comme un processus CLI séparé, en lecture seule ou en écriture, éventuellement isolé sur un worktree git jetable.

**Paramètres.** `objective` (requis) ; au moins l'un de `role` ou `agent` (un `agent` explicite l'emporte sur celui qu'un `role` aurait choisi, tandis que les autres valeurs par défaut du rôle s'appliquent toujours) ; `mode`, `isolation`, `network` ; `context`, `constraints`, `acceptance_criteria` ; `model` ; `timeout` ; `channel` (activation optionnelle du canal retour MCP, voir ci-dessous).

**Retourne.** `task_id`, les `agent`/`mode`/`isolation`/`network`/`model` résolus, le `workspace`, et `status: "running"` — plus tout champ `*_warning` produit par la résolution (un désaccord de racine d'espace de travail, une garantie réseau qui n'a pas pu être honorée, une valeur de modèle par défaut qui a dû être abandonnée). Un refus de policy ou un rôle/agent inconnu revient comme un résultat d'erreur plutôt qu'un `task_id`.

:::note Cet appel n'attend pas
`caesar_delegate` renvoie la main dès que l'agent est résolu et que la délégation est approuvée par la policy — **il n'attend pas que le sous-agent termine**, ce qui peut prendre de quelques secondes jusqu'au timeout configuré. La tâche est encore en cours quand cet appel rend la main : appelez `caesar_await` avec le `task_id` renvoyé pour obtenir le résultat réel. Pour exécuter plusieurs providers sur le même objectif en parallèle, appelez `caesar_delegate` plusieurs fois d'affilée, puis un seul `caesar_await` avec tous les `task_id` — ne pas bloquer est tout l'intérêt.
:::

### `caesar_await`

Attend qu'une ou plusieurs tâches démarrées par `caesar_delegate` se terminent, et retourne leurs rapports normalisés.

**Paramètres.** `task_ids` (tableau, requis) ; `timeout_ms` (30 secondes par défaut).

**Retourne.** Par tâche : `status`, `agent`, `role`, et une fois terminée, un `report` (`summary`, `changes`, `findings`, `questions`…). Les tâches encore en cours quand `timeout_ms` s'écoule reviennent avec `pending: true` au lieu d'un rapport — et, si le sous-agent a appelé `ask_orchestrator` et attend toujours une réponse, avec `pending_questions` listant ce qu'il a demandé, de sorte qu'une tâche qui vous attend n'est jamais indiscernable d'une tâche simplement encore au travail.

Le `changes_verified_by` du rapport indique dans quelle mesure faire confiance à la liste des fichiers modifiés : `"git"` signifie qu'elle a été recoupée avec l'état git réel de l'espace de travail (vrai chaque fois que l'espace de travail est un dépôt git, dans les deux isolations) ; `"declaration"` signifie qu'aucune vérification git n'était possible et que c'est seulement l'affirmation propre du sous-agent.

### `caesar_status`

Un instantané non bloquant et peu coûteux d'une tâche — jamais le rapport complet, et n'attend jamais.

**Paramètres.** `task_id`.

**Retourne.** `status` (le résultat du processus — `pending`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out`), des horodatages, `agent`, `role`, `mode`, `isolation`, le `last_event` enregistré jusqu'ici, et `pending_questions`. Une fois que la tâche a produit un rapport, `report_status` (`success`, `partial`, `failed`, `blocked` — le verdict propre du sous-agent) est aussi inclus. `status` ne reflète que le résultat du processus, pas ce que le sous-agent a rapporté : un sous-agent qui écrit `{"status":"failed"}` et sort tout de même en `0` affiche ici `status: succeeded` — vérifiez aussi `report_status` avant de supposer qu'une tâche a réellement réussi.

### `caesar_logs`

Un extrait de l'activité d'une tâche — événements normalisés par défaut, ou la sortie CLI brute du sous-agent avec `raw: true`. Utilisez-le pour diagnostiquer une tâche qui a échoué, expiré, ou produit un rapport surprenant ; `caesar_status` et `caesar_await` omettent délibérément ce niveau de détail pour rester compacts.

**Paramètres.** `task_id` ; `raw` (bool) ; `limit` (événements normalisés les plus récents à retourner, 50 par défaut, ignoré quand `raw` est vrai).

**Retourne.** `total_events` plus les événements les plus récents (ou le texte brut, tronqué à une taille de queue fixe), afin de savoir combien a été coupé.

### `caesar_cancel`

Annule une tâche encore en cours : signale au processus du sous-agent de s'arrêter (`SIGTERM`, escaladant vers `SIGKILL` s'il ne se termine pas) et attend que l'arrêt soit complet avant de rendre la main.

**Paramètres.** `task_id`.

**Retourne.** `cancelled` (bool), `status`. Sans risque à appeler sur une tâche déjà terminée — c'est alors un no-op qui se contente de rapporter le statut final, `cancelled: false`.

### `caesar_diff`

Le diff git d'une tâche exécutée avec isolation par worktree : quels fichiers ont changé, comment, et le patch unifié complet. Utilisez-le après que `caesar_await` rapporte une tâche terminée, pour inspecter ce qu'elle a réellement fait avant de décider de la `caesar_apply` — particulièrement quand le même objectif a été délégué à plusieurs providers en parallèle et que vous voulez comparer leurs diffs avant d'en choisir un.

**Paramètres.** `task_id`.

**Retourne.** `is_empty`, `files`, `patch`. `is_empty: true` sans patch pour les tâches exécutées en `inplace` (pas de worktree) ou n'ayant fait aucun changement.

### `caesar_apply`

Applique le diff d'une tâche de worktree au dépôt principal (`git apply --3way`) ; ne committe jamais, ne touche jamais aux branches. Utilisez-le une fois le résultat relu — typiquement via `caesar_diff` — et la décision prise de le garder.

**Paramètres.** `task_id`.

**Retourne.** `applied` (bool), `conflicts`. Rapporte des conflits plutôt qu'une application partielle quand le patch ne s'applique plus proprement ; un no-op (`applied: true`, aucun conflit) pour les tâches exécutées en `inplace` ou n'ayant fait aucun changement.

### `caesar_list_agents`

Liste chaque provider de sous-agent que caesar connaît : si sa CLI est réellement installée sur cette machine, ce qu'il sait faire (mode lecture seule natif, sortie structurée, sessions reprenables, sélection de modèle…), le modèle par défaut configuré pour lui, et si la policy actuelle autoriserait de lui déléguer en ce moment. Appelez ceci avant `caesar_delegate` en cas de doute sur les providers utilisables, ou pour les comparer avant d'en faire courir plusieurs en parallèle.

**Paramètres.** Aucun.

**Retourne.** `agents[]` — `id`, `display_name`, `bin`, `installed`, `path`, `capabilities`, `default_model` (si configuré), `policy` (`allowed`, ou `allowed: false` avec la raison du refus).

### `caesar_list_roles`

Liste les rôles configurés pour le projet : intention, mode/isolation/network par défaut, le modèle qu'il demande le cas échéant, et — résolu en ce moment même contre les binaires installés et la policy actuelle — quel agent `caesar_delegate` choisirait réellement pour lui, y compris la chaîne de repli et pourquoi tout candidat antérieur a été sauté. Utilisez-le pour décider entre déléguer via un rôle ou nommer un agent directement.

**Paramètres.** Aucun.

**Retourne.** `roles[]` — `name`, `purpose`, `mode`, `isolation`, `network`, `timeout_ms`, `model`, `agents` (ordre de repli), `would_pick`, `reason`, `skipped`.

### `caesar_answer`

Répond à une question qu'un sous-agent délégué a posée en cours d'exécution via son outil `ask_orchestrator`. Il ne liste pas lui-même les questions en attente — découvrez-les d'abord via `caesar_status` (une seule tâche) ou `caesar_await` (les tâches sur lesquelles il attend encore).

**Paramètres.** `task_id`, `question_id`, `answer`.

**Retourne.** `answered: true`. Répondre à un `task_id`/`question_id` inconnu, ou à une question qui a déjà une réponse, échoue clairement plutôt que d'écrire silencieusement.

## Le canal retour

Passer `channel: true` à `caesar_delegate` charge un petit serveur MCP (`@caesar/mcp-channel`) à l'intérieur du propre processus du sous-agent, accessible uniquement pendant l'exécution de cette tâche — un provider incapable de charger un serveur MCP ignore simplement ce champ. Aux côtés d'une commodité `get_task` (relit la mission depuis `task.json`), trois outils transforment la délégation en dialogue plutôt qu'en aller-retour muet :

- **`report_progress`** — `(message, pct?)`. Ajoute un événement de progression au journal de la tâche, visible par l'orchestrateur via `caesar_status`/`caesar_logs` sans terminer la tâche.
- **`ask_orchestrator`** — `(question, options?)`. Enregistre la question immédiatement, de sorte qu'elle apparaisse dans `caesar_status`/`caesar_await` comme une entrée `pending_questions`, puis bloque jusqu'à ce que `caesar_answer` fournisse une réponse ou qu'un timeout s'écoule (5 minutes par défaut, jamais plus long que ce qui reste de l'échéance propre de la tâche). Sans réponse à temps, l'appel revient normalement — pas une erreur — invitant le sous-agent à poursuivre selon son propre meilleur jugement.
- **`submit_report`** — le plus fiable des quatre paliers de récupération de rapport : remet le rapport final, validé immédiatement contre le schéma du rapport.

Désactivé par défaut : l'activer ajoute un processus et une injection de configuration à chaque délégation, c'est donc opt-in plutôt qu'automatique.

## Prochaines étapes

- [Utiliser caesar depuis Claude Code](../guides/claude-code.md) — enregistrer ces outils et la skill qui les dirige.
- [Le standard OACP](../protocol/overview.md) — le contrat basé sur les fichiers sur lequel reposent ces outils.
- [Déléguer des tâches](../guides/delegating.md) — quoi déléguer, et comment le briefer.
