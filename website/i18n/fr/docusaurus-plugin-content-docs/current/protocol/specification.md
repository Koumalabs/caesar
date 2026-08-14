---
title: Spécification
sidebar_position: 2
description: La spécification OACP complète — task.json, report.json, events.jsonl, les quatre paliers de récupération de rapport, le canal retour MCP optionnel, et le versioning.
---

{/* Source: docs/protocol.md — manual resync */}

# Spécification

Version `1` · documents `caesar.task/v1`, `caesar.report/v1`, `caesar.event/v1`

Ce document décrit le contrat qui permet à un orchestrateur de confier une tâche à un agent de code, quel qu'il soit, et de recevoir en retour un rapport exploitable.

Le contrat repose sur le **système de fichiers**, pas sur un SDK. Aucune bibliothèque n'est requise : un programme capable de lire et d'écrire du JSON peut jouer le rôle de sous-agent. C'est délibéré — un standard qui exige une dépendance n'est adopté que par ceux qui l'écrivent.

## Le cycle

```
orchestrator                                       agent
     │
     │  writes task.json
     │  starts the process with $CAESAR_* in the environment
     ├────────────────────────────────────────────────►
     │                                                │  reads $CAESAR_TASK_FILE
     │                                                │  works
     │            ◄─ events.jsonl (optional) ─────────┤
     │                                                │  writes $CAESAR_REPORT_PATH
     │  ◄─────────────────────────────────────────────┤  exits
     │  reads report.json, reconciles with git diff
```

## Le répertoire de la tâche

Chaque tâche possède son répertoire, dont le chemin est passé via `$CAESAR_TASK_DIR` :

| Fichier | Signification | Auteur |
|---|---|---|
| `task.json` | La tâche | orchestrateur |
| `report.json` | Le rapport | agent |
| `events.jsonl` | Le flux de progression, une ligne JSON par événement | agent ou adaptateur |
| `raw.log` | Sortie brute du processus, pour diagnostic | orchestrateur |
| `questions/<id>.json` | Une question posée via le canal retour (optionnel) | agent |
| `answers/<id>.json` | La réponse à cette question | orchestrateur |

`questions/` et `answers/` n'existent que si la tâche utilise le canal retour (voir plus bas) : c'est là que `ask_orchestrator` et sa réponse se rencontrent, sur le système de fichiers comme le reste du standard — aucune mémoire n'est partagée entre le processus de l'agent et celui de l'orchestrateur.

## Variables d'environnement

Le contrat minimal tient en deux d'entre elles : `CAESAR_TASK_FILE` à lire, `CAESAR_REPORT_PATH` à écrire.

| Variable | Contenu |
|---|---|
| `CAESAR_TASK_DIR` | Répertoire de la tâche |
| `CAESAR_TASK_FILE` | Chemin de `task.json` |
| `CAESAR_REPORT_PATH` | Chemin où `report.json` doit être déposé |
| `CAESAR_EVENTS_PATH` | Chemin de `events.jsonl` |
| `CAESAR_TASK_ID` | Identifiant de la tâche |
| `CAESAR_AGENT` | Identifiant de l'agent en cours d'exécution |
| `CAESAR_DEPTH` | Profondeur de délégation, `0` pour l'agent principal |
| `CAESAR_PROTOCOL_VERSION` | Version du standard |

## `task.json` — la tâche

```json
{
  "protocol": "caesar.task/v1",
  "id": "t_7f3a",
  "created_at": "2026-08-09T10:00:00.000Z",
  "role": "reviewer",              // optional: the requested profile
  "agent": "codex",                // the selected agent
  "objective": "Fix the parser regression on empty inputs",
  "context": "…",                  // excerpts, history, links
  "constraints": ["Do not touch the public API"],
  "acceptance_criteria": ["pnpm test passes"],
  "mode": "write",                 // "read-only" | "write"
  "isolation": "worktree",         // "inplace" | "worktree"
  "network": true,                 // is the network available? (default: true)
  "workspace": "/abs/path",        // working root
  "base_ref": "3f2a91c…",          // under worktree isolation: the SHA of the starting point
  "deadline_ms": 600000,
  "depth": 1,
  "report_path": "/abs/.caesar/tasks/t_7f3a/report.json",
  "events_path": "/abs/.caesar/tasks/t_7f3a/events.jsonl",
  "channel": null                  // return channel coordinates, if available
}
```

`network` est un résultat, pas une demande : l'orchestrateur a déjà confronté ce que l'appelant voulait avec ce que l'agent sélectionné autorise. À `false`, cela affirme que le réseau est coupé, et le brief le dit à l'agent — ce qui n'arrive que lorsque l'orchestrateur le sait. Un agent dont il ne contrôle pas le confinement reçoit `true`, faute de pouvoir affirmer autre chose. Le champ est optionnel en lecture et vaut `true` par défaut, afin qu'un `task.json` écrit avant son introduction se relise inchangé.

## `report.json` — le rapport

Seuls `protocol`, `status` et `summary` sont requis. Tout le reste a une valeur par défaut : un rapport minimal est valide.

```json
{
  "protocol": "caesar.report/v1",
  "task_id": "t_7f3a",
  "status": "success",             // success | partial | failed | blocked
  "summary": "Two files fixed, the tests pass.",
  "details": "…",
  "changes": [
    { "path": "src/parser.ts", "action": "modified", "summary": "guard on empty input" }
  ],
  "commands_run": [{ "command": "pnpm test", "exit_code": 0 }],
  "findings": [
    { "severity": "medium", "title": "…", "file": "src/x.ts", "line": 42, "detail": "…" }
  ],
  "questions": [{ "id": "q1", "question": "Should the old behavior be kept?", "options": ["yes", "no"] }],
  "next_steps": ["Document the change"],
  "artifacts": [{ "path": "bench.json", "description": "before/after measurements" }],
  "usage": { "input_tokens": 12000, "output_tokens": 3000, "duration_ms": 84000 }
}
```

La signification des statuts :

- **`success`** — les critères d'acceptation sont remplis.
- **`partial`** — une partie du travail est faite ; ce qui reste est décrit dans `next_steps`.
- **`failed`** — l'agent n'a pas réussi et n'a aucune issue.
- **`blocked`** — une décision hors de son périmètre est requise ; elle est posée dans `questions`.

`changes` est la déclaration de l'agent. Quand l'espace de travail de la tâche est un dépôt git — aussi bien en isolation `worktree` qu'`inplace` — l'orchestrateur la réconcilie avec l'état git observé, **qui seul fait foi** ; c'est alors le seul cas où `changes` reflète la réalité plutôt que la seule parole de l'agent. En dehors d'un dépôt git (aucune réconciliation possible), `changes` reste la déclaration brute. Le rapport normalisé retourné par [`caesar_await`/`caesar_delegate`](../reference/mcp-tools.md) porte cette distinction dans `changes_verified_by` (`"git"` ou `"declaration"`).

Deux propriétés de cette réconciliation méritent d'être précisées, parce que le worktree est un **atelier** où le sous-agent installe, exécute et vérifie :

- **Le diff est pris contre `base_ref`, jamais contre `HEAD`.** `base_ref` est le SHA du point de départ, figé à la création du worktree. Un agent qui committe son travail — ce qu'un atelier lui permet de faire — déplacerait `HEAD` sur son propre commit, et un diff contre `HEAD` ressortirait vide : l'orchestrateur conclurait « aucun changement » et `caesar apply` n'appliquerait rien. Contre le SHA de départ, le résultat est le même que l'agent committe ou non.
- **Ce que l'orchestrateur lui-même a déposé est exclu.** Les chemins matérialisés dans le worktree par `[worktree] copy`/`link` (dépendances, `.env`) sont retirés du diff, avec une sémantique de préfixe — un répertoire déposé exclut ce qu'il contient. Ils sont enregistrés dans le dossier de la tâche, de sorte que `caesar diff` et `caesar apply`, qui recalculent le diff bien plus tard, les excluent eux aussi.

## `events.jsonl` — le flux

Une ligne JSON par événement, en ajout seul. Chaque ligne se suffit à elle-même. C'est le vocabulaire commun dans lequel chaque adaptateur traduit le flux natif de sa CLI, et c'est ce qui rend les providers interchangeables vus de l'agent principal.

```json
{"protocol":"caesar.event/v1","seq":0,"at":"…","task_id":"t_7f3a","type":"started","agent":"codex","command":"codex exec …"}
{"protocol":"caesar.event/v1","seq":1,"at":"…","task_id":"t_7f3a","type":"tool_use","tool":"bash","id":"item_1","input_summary":"pnpm test","status":"started"}
{"protocol":"caesar.event/v1","seq":2,"at":"…","task_id":"t_7f3a","type":"tool_use","tool":"bash","id":"item_1","input_summary":"pnpm test","status":"succeeded"}
{"protocol":"caesar.event/v1","seq":3,"at":"…","task_id":"t_7f3a","type":"finished","status":"success","summary":"…"}
```

Types disponibles : `started`, `thinking`, `message`, `tool_use`, `file_changed`, `progress`, `question`, `answer`, `error`, `finished`.

Deux points sur `tool_use`, qui déterminent ce qu'un observateur ([`caesar watch`](../guides/watch.md)) peut montrer d'une tâche en cours :

- **Émettre le `started`, pas seulement le résultat.** Un outil rapporté une fois terminé n'apprend rien pendant qu'il s'exécute, et c'est précisément le moment où l'on observe. `codex` le fait, `opencode` non — la différence se voit à l'écran.
- **`id`** porte l'identifiant d'appel de l'agent, quand son flux en fournit un, et sert à apparier le début et la fin d'un seul et même appel. Sans lui, il faut réconcilier sur (nom, résumé), ce qui confond deux exécutions successives de la même commande. C'est parfois le seul recours : avec `claude`, la fin d'un outil arrive dans un bloc qui ne porte que cet identifiant, jamais le nom — l'événement de fermeture a donc un `tool` vide. Champ optionnel, vide par défaut : les journaux écrits avant son introduction se relisent sans problème.

Émettre des événements est **optionnel**. Un agent qui se contente d'écrire son rapport final reste parfaitement conforme — mais il sera, littéralement, invisible pendant tout son travail.

## Comment le rapport est récupéré

L'orchestrateur essaie quatre paliers, du plus fiable au plus tolérant, et garde le meilleur que l'agent peut honorer :

1. **Canal retour MCP** — l'agent appelle l'outil `submit_report`, validé à la volée.
2. **Schéma natif** — le provider contraint la réponse finale (`codex --output-schema`, `agy --json-schema`).
3. **Contrat fichier** — l'agent écrit `$CAESAR_REPORT_PATH`. C'est le palier universel, celui pour les agents externes.
4. **Dégradé** — l'orchestrateur cherche dans la sortie un bloc ` ```json caesar:report `, à défaut tout objet JSON se déclarant lui-même comme un rapport, et en dernier recours synthétise un rapport à partir de `raw.log` et du diff git.

## Le canal retour, optionnel

Quand `task.channel` est renseigné, un serveur MCP est accessible pendant l'exécution et expose quatre outils :

| Outil | Usage |
|---|---|
| `get_task` | Relire la tâche |
| `report_progress` | Signaler une progression (`message`, `pct`) |
| `ask_orchestrator` | Poser une question et **attendre** la réponse de l'agent principal |
| `submit_report` | Remettre le rapport, validé immédiatement |

C'est ce qui transforme la délégation en dialogue plutôt qu'en aller-retour muet. Un agent incapable de charger un serveur MCP ignore simplement ce champ.

`ask_orchestrator` dépose la question dans `questions/<id>.json` puis attend que `answers/<id>.json` apparaisse (scrutin), au plus 5 minutes par défaut et jamais au-delà du temps restant sur le `deadline_ms` de la tâche. Sans réponse dans cette fenêtre, l'appel revient normalement — ce n'est pas une erreur — avec une invitation à poursuivre selon le meilleur jugement de l'agent plutôt que d'attendre indéfiniment. Côté orchestrateur, répondre est symétrique : l'outil [`caesar_answer`](../reference/mcp-tools.md) du serveur MCP principal (`@caesar/mcp-server`, hors du périmètre de ce standard mais fourni par l'implémentation de référence) écrit `answers/<id>.json` ; répondre à une question inconnue ou déjà répondue échoue explicitement plutôt que d'écrire silencieusement.

## Se conformer, en pratique

L'agent conforme le plus court tient en quelques lignes :

```bash
#!/usr/bin/env bash
objective=$(jq -r .objective "$CAESAR_TASK_FILE")

# … do the work …

jq -n --arg s "Handled: $objective" '{
  protocol: "caesar.report/v1",
  status: "success",
  summary: $s
}' > "$CAESAR_REPORT_PATH"
```

Déclaré dans `.caesar/config.toml` (section `[[agent]]`), il est orchestrable sur le même pied que Codex.

## Schémas exécutables

Les schémas font autorité en tant que code, et sont publiables en JSON Schema :

```bash
caesar protocol schema report          # JSON Schema of the report
caesar protocol schema report --strict # variant for native structured outputs
caesar protocol schema task
caesar protocol schema event
```

## Gestion des versions

Le champ `protocol` porte la version de chaque document. Un lecteur qui rencontre une version inconnue doit refuser explicitement plutôt que d'interpréter au mieux. Une évolution incompatible incrémentera le suffixe (`caesar.report/v2`), et l'orchestrateur acceptera les deux pendant la durée de la transition.

## Prochaines étapes

- [Aperçu](./overview.md) — le contrat condensé à ce dont un implémenteur de sous-agent a besoin en premier.
- [Outils MCP](../reference/mcp-tools.md) — les dix outils qui exposent ce standard du côté de l'orchestrateur.
- [Agents personnalisés](../guides/custom-agents.md) — câbler une CLI hors du catalogue contre ce contrat.
