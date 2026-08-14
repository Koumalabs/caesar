# Le standard OACP — Orchestrator–Agent Contract Protocol

Version `1` · documents `caesar.task/v1`, `caesar.report/v1`, `caesar.event/v1`

Ce document décrit le contrat qui permet à un orchestrateur de confier une tâche à un agent de code, quel qu'il soit, et d'en recevoir un compte rendu exploitable.

Le contrat repose sur le **système de fichiers**, pas sur un SDK. Aucune bibliothèque n'est requise : un programme qui sait lire et écrire du JSON peut jouer le rôle de sous-agent. C'est délibéré — un standard qui exige une dépendance n'est adopté que par ceux qui l'écrivent.

## Le cycle

```
orchestrateur                                      agent
     │
     │  écrit task.json
     │  lance le processus avec $CAESAR_* dans l'environnement
     ├────────────────────────────────────────────────►
     │                                                │  lit $CAESAR_TASK_FILE
     │                                                │  travaille
     │            ◄─ events.jsonl (facultatif) ───────┤
     │                                                │  écrit $CAESAR_REPORT_PATH
     │  ◄─────────────────────────────────────────────┤  se termine
     │  lit report.json, recoupe avec git diff
```

## Le répertoire de tâche

Chaque tâche possède son répertoire, dont le chemin est transmis par `$CAESAR_TASK_DIR` :

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

Le contrat minimal tient dans deux d'entre elles : `CAESAR_TASK_FILE` pour lire, `CAESAR_REPORT_PATH` pour écrire.

| Variable | Contenu |
|---|---|
| `CAESAR_TASK_DIR` | Répertoire de la tâche |
| `CAESAR_TASK_FILE` | Chemin de `task.json` |
| `CAESAR_REPORT_PATH` | Chemin où déposer `report.json` |
| `CAESAR_EVENTS_PATH` | Chemin de `events.jsonl` |
| `CAESAR_TASK_ID` | Identifiant de la tâche |
| `CAESAR_AGENT` | Identifiant de l'agent exécutant |
| `CAESAR_DEPTH` | Profondeur de délégation, `0` pour l'agent principal |
| `CAESAR_PROTOCOL_VERSION` | Version du standard |

## `task.json` — la mission

```jsonc
{
  "protocol": "caesar.task/v1",
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
  "network": true,                 // le réseau est-il disponible ? (défaut : true)
  "workspace": "/abs/path",        // racine de travail
  "base_ref": "3f2a91c…",          // en isolation worktree : le SHA du point de départ
  "deadline_ms": 600000,
  "depth": 1,
  "report_path": "/abs/.caesar/tasks/t_7f3a/report.json",
  "events_path": "/abs/.caesar/tasks/t_7f3a/events.jsonl",
  "channel": null                  // coordonnées du canal retour, si disponible
}
```

`network` est un résultat, pas une demande : l'orchestrateur y a déjà confronté ce que l'appelant souhaitait à ce que l'agent retenu permet. À `false`, il affirme que le réseau est coupé, et le brief le dit à l'agent — ce qui n'arrive que lorsque l'orchestrateur le sait. Un agent dont il ne pilote pas le confinement reçoit `true`, faute de pouvoir affirmer le contraire. Le champ est facultatif à la lecture et vaut `true` par défaut, de sorte qu'un `task.json` écrit avant son introduction se relit inchangé.

## `report.json` — le compte rendu

Seuls `protocol`, `status` et `summary` sont exigés. Tout le reste a une valeur par défaut : un rapport minimal est valide.

```jsonc
{
  "protocol": "caesar.report/v1",
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

`changes` relève de la déclaration de l'agent. Quand le workspace de la tâche est un dépôt git — en isolation `worktree` comme `inplace` — l'orchestrateur la recoupe avec l'état git constaté, **qui seul fait foi** ; c'est alors le seul cas où `changes` reflète la réalité plutôt que la seule parole de l'agent. Hors dépôt git (aucun recoupement possible), `changes` reste la déclaration brute. Le rapport normalisé rendu par `caesar_await`/`caesar_delegate` porte cette distinction dans `changes_verified_by` (`"git"` ou `"declaration"`).

Deux propriétés de ce recoupement méritent d'être dites, parce que le worktree est un **atelier** où le sous-agent installe, exécute et vérifie :

- **Le diff porte contre `base_ref`, jamais contre `HEAD`.** `base_ref` est le SHA du point de départ, figé à la création du worktree. Un agent qui commite son travail — ce qu'un atelier l'autorise à faire — déplacerait `HEAD` sur son propre commit, et un diff contre `HEAD` rendrait vide : l'orchestrateur conclurait « aucun changement » et `caesar apply` n'appliquerait rien. Contre le SHA de départ, le résultat est le même que l'agent commite ou non.
- **Ce que l'orchestrateur a lui-même posé est exclu.** Les chemins matérialisés dans le worktree depuis `[worktree] copy`/`link` (dépendances, `.env`) sont retirés du diff, avec une sémantique de préfixe — un répertoire posé exclut ce qu'il contient. Ils sont notés dans l'enregistrement de la tâche, de sorte que `caesar diff` et `caesar apply`, qui recalculent le diff longtemps après, les excluent aussi.

## `events.jsonl` — le flux

Une ligne JSON par événement, en append-only. Chaque ligne se suffit à elle-même. C'est le vocabulaire commun vers lequel chaque adaptateur traduit le flux natif de son CLI, et c'est ce qui rend les providers interchangeables vus de l'agent principal.

```jsonc
{"protocol":"caesar.event/v1","seq":0,"at":"…","task_id":"t_7f3a","type":"started","agent":"codex","command":"codex exec …"}
{"protocol":"caesar.event/v1","seq":1,"at":"…","task_id":"t_7f3a","type":"tool_use","tool":"bash","id":"item_1","input_summary":"pnpm test","status":"started"}
{"protocol":"caesar.event/v1","seq":2,"at":"…","task_id":"t_7f3a","type":"tool_use","tool":"bash","id":"item_1","input_summary":"pnpm test","status":"succeeded"}
{"protocol":"caesar.event/v1","seq":3,"at":"…","task_id":"t_7f3a","type":"finished","status":"success","summary":"…"}
```

Types disponibles : `started`, `thinking`, `message`, `tool_use`, `file_changed`, `progress`, `question`, `answer`, `error`, `finished`.

Deux points sur `tool_use`, qui décident de ce qu'un observateur (`caesar watch`) peut montrer d'une tâche en cours :

- **Émettez le `started`, pas seulement l'issue.** Un outil signalé une fois terminé n'apprend rien pendant qu'il tourne, et c'est justement le moment où l'on regarde. `codex` le fait, `opencode` non — la différence se voit à l'écran.
- **`id`** porte l'identifiant d'appel de l'agent, quand son flux en fournit un, et sert à apparier le départ et la fin d'un même appel. Sans lui, il faut recouper sur (nom, résumé), ce qui confond deux exécutions successives de la même commande. Il est parfois le seul recours : chez `claude`, la fin d'un outil arrive dans un bloc qui ne porte que cet identifiant, jamais le nom — l'événement de fermeture a donc un `tool` vide. Champ facultatif, vide par défaut : les journaux écrits avant son introduction se relisent.

Émettre des événements est **facultatif**. Un agent qui se contente d'écrire son rapport final reste parfaitement conforme — mais il sera, littéralement, invisible pendant tout son travail.

## Comment le rapport est récupéré

L'orchestrateur essaie quatre paliers, du plus fiable au plus tolérant, et retient le meilleur que l'agent sait honorer :

1. **Canal retour MCP** — l'agent appelle le tool `submit_report`, validé à la volée.
2. **Schéma natif** — le fournisseur contraint la réponse finale (`codex --output-schema`, `agy --json-schema`).
3. **Contrat de fichier** — l'agent écrit `$CAESAR_REPORT_PATH`. C'est le palier universel, celui des agents extérieurs.
4. **Dégradé** — l'orchestrateur cherche dans la sortie un bloc ` ```json caesar:report `, à défaut tout objet JSON se déclarant comme un rapport, et en dernier ressort synthétise un compte rendu à partir de `raw.log` et du diff git.

## Le canal retour, facultatif

Quand `task.channel` est renseigné, un serveur MCP est joignable pendant l'exécution et expose quatre tools :

| Tool | Usage |
|---|---|
| `get_task` | Relire la mission |
| `report_progress` | Signaler un avancement (`message`, `pct`) |
| `ask_orchestrator` | Poser une question et **attendre** la réponse de l'agent principal |
| `submit_report` | Remettre le rapport, validé immédiatement |

C'est ce qui transforme la délégation en dialogue plutôt qu'en aller-retour muet. Un agent qui ne sait pas charger de serveur MCP ignore simplement ce champ.

`ask_orchestrator` dépose la question dans `questions/<id>.json` puis attend l'apparition d'`answers/<id>.json` (scrutation), au plus 5 minutes par défaut et jamais au-delà du temps restant sur `deadline_ms` de la tâche. Sans réponse dans ce délai, l'appel rend la main normalement — ce n'est pas une erreur — avec une invitation à poursuivre au meilleur jugement de l'agent plutôt que d'attendre indéfiniment. Côté orchestrateur, répondre est symétrique : le tool `caesar_answer` du serveur MCP principal (`@caesar/mcp-server`, hors du périmètre de ce standard mais fourni par l'implémentation de référence) écrit `answers/<id>.json` ; répondre à une question inconnue ou déjà répondue échoue explicitement plutôt que d'écrire en silence.

## Se conformer, en pratique

Le plus court agent conforme tient en quelques lignes :

```bash
#!/usr/bin/env bash
objective=$(jq -r .objective "$CAESAR_TASK_FILE")

# … faire le travail …

jq -n --arg s "Traité : $objective" '{
  protocol: "caesar.report/v1",
  status: "success",
  summary: $s
}' > "$CAESAR_REPORT_PATH"
```

Déclaré dans `.caesar/config.toml` (section `[[agent]]`), il est orchestrable au même titre que Codex.

## Schémas exécutables

Les schémas font autorité sous forme de code, et sont publiables en JSON Schema :

```bash
caesar protocol schema report          # JSON Schema du rapport
caesar protocol schema report --strict # variante pour sorties structurées natives
caesar protocol schema task
caesar protocol schema event
```

## Versionnement

Le champ `protocol` porte la version de chaque document. Un lecteur qui rencontre une version inconnue doit refuser explicitement plutôt que d'interpréter au mieux. Une évolution incompatible incrémentera le suffixe (`caesar.report/v2`), et l'orchestrateur acceptera les deux le temps de la transition.
