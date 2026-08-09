# Le standard OACP — Orchestrator–Agent Contract Protocol

Version `1` · documents `orch.task/v1`, `orch.report/v1`, `orch.event/v1`

Ce document décrit le contrat qui permet à un orchestrateur de confier une tâche à un agent de code, quel qu'il soit, et d'en recevoir un compte rendu exploitable.

Le contrat repose sur le **système de fichiers**, pas sur un SDK. Aucune bibliothèque n'est requise : un programme qui sait lire et écrire du JSON peut jouer le rôle de sous-agent. C'est délibéré — un standard qui exige une dépendance n'est adopté que par ceux qui l'écrivent.

## Le cycle

```
orchestrateur                                      agent
     │
     │  écrit task.json
     │  lance le processus avec $ORCH_* dans l'environnement
     ├────────────────────────────────────────────────►
     │                                                │  lit $ORCH_TASK_FILE
     │                                                │  travaille
     │            ◄─ events.jsonl (facultatif) ───────┤
     │                                                │  écrit $ORCH_REPORT_PATH
     │  ◄─────────────────────────────────────────────┤  se termine
     │  lit report.json, recoupe avec git diff
```

## Le répertoire de tâche

Chaque tâche possède son répertoire, dont le chemin est transmis par `$ORCH_TASK_DIR` :

| Fichier | Sens | Auteur |
|---|---|---|
| `task.json` | La mission | orchestrateur |
| `report.json` | Le compte rendu | agent |
| `events.jsonl` | Le flux d'avancement, une ligne JSON par événement | agent ou adaptateur |
| `raw.log` | Sortie brute du processus, pour le diagnostic | orchestrateur |
| `questions/<id>.json` | Une question posée via le canal retour (facultatif) | agent |
| `answers/<id>.json` | La réponse à cette question | orchestrateur |

`questions/` et `answers/` n'existent que si la tâche utilise le canal retour (ci-dessous) : c'est là que `ask_orchestrator` et sa réponse se rencontrent, sur le système de fichiers comme le reste du standard — aucune mémoire n'est partagée entre le processus de l'agent et celui de l'orchestrateur.

## Variables d'environnement

Le contrat minimal tient dans deux d'entre elles : `ORCH_TASK_FILE` pour lire, `ORCH_REPORT_PATH` pour écrire.

| Variable | Contenu |
|---|---|
| `ORCH_TASK_DIR` | Répertoire de la tâche |
| `ORCH_TASK_FILE` | Chemin de `task.json` |
| `ORCH_REPORT_PATH` | Chemin où déposer `report.json` |
| `ORCH_EVENTS_PATH` | Chemin de `events.jsonl` |
| `ORCH_TASK_ID` | Identifiant de la tâche |
| `ORCH_AGENT` | Identifiant de l'agent exécutant |
| `ORCH_DEPTH` | Profondeur de délégation, `0` pour l'agent principal |
| `ORCH_PROTOCOL_VERSION` | Version du standard |

## `task.json` — la mission

```jsonc
{
  "protocol": "orch.task/v1",
  "id": "t_7f3a",
  "created_at": "2026-08-09T10:00:00.000Z",
  "role": "reviewer",              // facultatif : le profil demandé
  "agent": "codex",                // l'agent retenu
  "objective": "Corriger la régression du parseur sur les entrées vides",
  "context": "…",                  // extraits, historique, liens
  "constraints": ["Ne pas toucher à l'API publique"],
  "acceptance_criteria": ["pnpm test passe"],
  "mode": "write",                 // "read-only" | "write"
  "isolation": "worktree",         // "inplace" | "worktree"
  "workspace": "/abs/path",        // racine de travail
  "base_ref": "main",              // en isolation worktree
  "deadline_ms": 600000,
  "depth": 1,
  "report_path": "/abs/.orch/tasks/t_7f3a/report.json",
  "events_path": "/abs/.orch/tasks/t_7f3a/events.jsonl",
  "channel": null                  // coordonnées du canal retour, si disponible
}
```

## `report.json` — le compte rendu

Seuls `protocol`, `status` et `summary` sont exigés. Tout le reste a une valeur par défaut : un rapport minimal est valide.

```jsonc
{
  "protocol": "orch.report/v1",
  "task_id": "t_7f3a",
  "status": "success",             // success | partial | failed | blocked
  "summary": "Deux fichiers corrigés, les tests passent.",
  "details": "…",
  "changes": [
    { "path": "src/parser.ts", "action": "modified", "summary": "garde sur entrée vide" }
  ],
  "commands_run": [{ "command": "pnpm test", "exit_code": 0 }],
  "findings": [
    { "severity": "medium", "title": "…", "file": "src/x.ts", "line": 42, "detail": "…" }
  ],
  "questions": [{ "id": "q1", "question": "Faut-il conserver l'ancien comportement ?", "options": ["oui", "non"] }],
  "next_steps": ["Documenter le changement"],
  "artifacts": [{ "path": "bench.json", "description": "mesures avant/après" }],
  "usage": { "input_tokens": 12000, "output_tokens": 3000, "duration_ms": 84000 }
}
```

Le sens des statuts :

- **`success`** — les critères d'acceptation sont remplis.
- **`partial`** — une partie du travail est faite ; ce qui reste est décrit dans `next_steps`.
- **`failed`** — l'agent n'a pas abouti et n'a pas de chemin de sortie.
- **`blocked`** — une décision hors de son périmètre est requise ; elle est posée dans `questions`.

`changes` relève de la déclaration de l'agent. Quand le workspace de la tâche est un dépôt git — en isolation `worktree` comme `inplace` — l'orchestrateur la recoupe avec l'état git constaté, **qui seul fait foi** ; c'est alors le seul cas où `changes` reflète la réalité plutôt que la seule parole de l'agent. Hors dépôt git (aucun recoupement possible), `changes` reste la déclaration brute. Le rapport normalisé rendu par `orch_await`/`orch_delegate` porte cette distinction dans `changes_verified_by` (`"git"` ou `"declaration"`).

## `events.jsonl` — le flux

Une ligne JSON par événement, en append-only. Chaque ligne se suffit à elle-même. C'est le vocabulaire commun vers lequel chaque adaptateur traduit le flux natif de son CLI, et c'est ce qui rend les providers interchangeables vus de l'agent principal.

```jsonc
{"protocol":"orch.event/v1","seq":0,"at":"…","task_id":"t_7f3a","type":"started","agent":"codex","command":"codex exec …"}
{"protocol":"orch.event/v1","seq":1,"at":"…","task_id":"t_7f3a","type":"tool_use","tool":"bash","input_summary":"pnpm test","status":"succeeded"}
{"protocol":"orch.event/v1","seq":2,"at":"…","task_id":"t_7f3a","type":"finished","status":"success","summary":"…"}
```

Types disponibles : `started`, `thinking`, `message`, `tool_use`, `file_changed`, `progress`, `question`, `answer`, `error`, `finished`.

Émettre des événements est **facultatif**. Un agent qui se contente d'écrire son rapport final reste parfaitement conforme.

## Comment le rapport est récupéré

L'orchestrateur essaie quatre paliers, du plus fiable au plus tolérant, et retient le meilleur que l'agent sait honorer :

1. **Canal retour MCP** — l'agent appelle le tool `submit_report`, validé à la volée.
2. **Schéma natif** — le fournisseur contraint la réponse finale (`codex --output-schema`, `agy --json-schema`).
3. **Contrat de fichier** — l'agent écrit `$ORCH_REPORT_PATH`. C'est le palier universel, celui des agents extérieurs.
4. **Dégradé** — l'orchestrateur cherche dans la sortie un bloc ` ```json orch:report `, à défaut tout objet JSON se déclarant comme un rapport, et en dernier ressort synthétise un compte rendu à partir de `raw.log` et du diff git.

## Le canal retour, facultatif

Quand `task.channel` est renseigné, un serveur MCP est joignable pendant l'exécution et expose quatre tools :

| Tool | Usage |
|---|---|
| `get_task` | Relire la mission |
| `report_progress` | Signaler un avancement (`message`, `pct`) |
| `ask_orchestrator` | Poser une question et **attendre** la réponse de l'agent principal |
| `submit_report` | Remettre le rapport, validé immédiatement |

C'est ce qui transforme la délégation en dialogue plutôt qu'en aller-retour muet. Un agent qui ne sait pas charger de serveur MCP ignore simplement ce champ.

`ask_orchestrator` dépose la question dans `questions/<id>.json` puis attend l'apparition d'`answers/<id>.json` (scrutation), au plus 5 minutes par défaut et jamais au-delà du temps restant sur `deadline_ms` de la tâche. Sans réponse dans ce délai, l'appel rend la main normalement — ce n'est pas une erreur — avec une invitation à poursuivre au meilleur jugement de l'agent plutôt que d'attendre indéfiniment. Côté orchestrateur, répondre est symétrique : le tool `orch_answer` du serveur MCP principal (`@orch/mcp-server`, hors du périmètre de ce standard mais fourni par l'implémentation de référence) écrit `answers/<id>.json` ; répondre à une question inconnue ou déjà répondue échoue explicitement plutôt que d'écrire en silence.

## Se conformer, en pratique

Le plus court agent conforme tient en quelques lignes :

```bash
#!/usr/bin/env bash
objective=$(jq -r .objective "$ORCH_TASK_FILE")

# … faire le travail …

jq -n --arg s "Traité : $objective" '{
  protocol: "orch.report/v1",
  status: "success",
  summary: $s
}' > "$ORCH_REPORT_PATH"
```

Déclaré dans `.orch/config.toml` (section `[[agent]]`), il est orchestrable au même titre que Codex.

## Schémas exécutables

Les schémas font autorité sous forme de code, et sont publiables en JSON Schema :

```bash
orch protocol schema report          # JSON Schema du rapport
orch protocol schema report --strict # variante pour sorties structurées natives
orch protocol schema task
orch protocol schema event
```

## Versionnement

Le champ `protocol` porte la version de chaque document. Un lecteur qui rencontre une version inconnue doit refuser explicitement plutôt que d'interpréter au mieux. Une évolution incompatible incrémentera le suffixe (`orch.report/v2`), et l'orchestrateur acceptera les deux le temps de la transition.
