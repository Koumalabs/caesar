# agent-orchestrateur

Un orchestrateur qui permet à un agent de code — typiquement Claude Code — de déléguer des tâches à des sous-agents **externes** (Codex, Antigravity, OpenCode, Copilot, ou même une autre instance de Claude Code) exécutés comme de simples processus CLI, exactement comme il déléguerait à un sous-agent natif.

Le problème qu'il résout : chaque CLI d'agent de code a sa propre façon de recevoir une mission, de rendre un compte rendu, de signaler qu'il a besoin d'une précision. Sans couche commune, comparer deux providers sur la même tâche, ou simplement fiabiliser un aller-retour avec l'un d'eux, veut dire réapprendre son format à chaque fois — et croire sur parole ce qu'il prétend avoir modifié. `agent-orchestrateur` normalise ce cycle : un standard de communication commun (`docs/protocol.md`), un moteur qui isole chaque tâche sur un worktree git jetable, et un recoupement systématique entre ce que l'agent déclare et ce que `git diff` constate — le diff fait foi, jamais la seule déclaration de l'agent.

Ce dépôt livre un CLI (`orch`), un serveur MCP à dix tools pour piloter tout ça depuis Claude Code (ou tout autre client MCP), un TUI de configuration, et trois sous-agents Claude Code prêts à l'emploi dans `.claude/agents/`.

## Agents pris en charge

| Agent | Identifiant | Binaire attendu | Mode headless | Réseau |
|---|---|---|---|---|
| Codex | `codex` | `codex` | `codex exec --json -s <read-only\|workspace-write> …` | en écriture seule |
| Antigravity CLI | `antigravity` | `agy` | `agy --print <prompt> --output-format stream-json --mode <plan\|accept-edits> …` | ouvert |
| OpenCode | `opencode` | `opencode` | `opencode run --format json --dir <workspace> …` | ouvert |
| GitHub Copilot CLI | `copilot` | `copilot` | `copilot --prompt <prompt> --output-format json --no-color --log-level none …` | pilotable |
| Claude Code | `claude` | `claude` | `claude --print <prompt> --output-format json --permission-mode <plan\|acceptEdits> …` | ouvert |

Le détail complet des flags (schéma de sortie natif, canal MCP, modèle, répertoires additionnels…) est dans `packages/core/src/adapters/*.ts`, un fichier par agent — chaque flag y a été vérifié par `--help` sur une machine réelle, aucun n'est inventé.

La colonne **Réseau** dit ce qu'`orch` sait *piloter*, et non ce dont l'agent est capable — la distinction compte. « Ouvert » signifie que nos arguments ne passent aucun confinement, donc que nous ne saurions pas le refermer. « Pilotable » : nous savons l'ouvrir dans les deux modes (`copilot --allow-all-urls`, distinct de `--allow-all-tools`, qui ne couvre pas les URL). « En écriture seule » : le bac à sable de `codex` n'expose son réglage réseau que sous `sandbox_workspace_write` — en `-s read-only`, le réseau est coupé sans recours.

C'est la raison d'être du réglage `network`, disponible à trois niveaux (politique, rôle, tâche) et tri-état :

```bash
orch run --agent codex --mode write "installe la dépendance manquante"   # auto : ouvert, ici c'est possible
orch run --agent codex --mode read-only --network on "…"                 # refusé, avec le motif et le remède
orch run --agent codex --mode write --network off "…"                    # réseau coupé explicitement
```

- `auto` (défaut) — ouvre le réseau partout où l'agent choisi le permet ; ailleurs, la tâche part quand même et le rapport porte un constat `info`. C'est ce qui permet aux rôles `reviewer` et `investigator`, en lecture seule sur codex, de continuer à tourner.
- `on` — **fait échouer la délégation** si l'agent ne peut pas fournir le réseau, avant tout lancement et sans laisser de répertoire de tâche. À préférer dès que l'objectif est impossible sans réseau : un refus net vaut mieux qu'un sous-agent qui épuise son budget sur une installation vouée à l'échec.
- `off` — ferme là où c'est possible. Là où ça ne l'est pas, `orch` le dit plutôt que d'annoncer une garantie qu'il n'a pas.

Quand — et seulement quand — `orch` sait le réseau coupé, il l'écrit dans le brief de l'agent, pour lui éviter d'y user ses tours.

Un mot sur `claude` : il figure au catalogue (déléguer d'une instance de Claude Code à une autre a du sens — relecture croisée, par exemple), mais la politique par défaut le refuse (`allow_recursion: false`) précisément parce que c'est le cas le plus susceptible de tourner en boucle. `orch agents enable claude` ou `orch policy allow claude` lève ce refus explicitement, si besoin.

## Installation et premiers pas

Monorepo pnpm, Node 24. Pas encore publié sur npm : on l'utilise depuis une copie du dépôt, en ciblant avec `--root` le projet où vous voulez déléguer des tâches.

```bash
pnpm install
pnpm exec tsc -b        # build de tous les packages

pnpm run orch init   --root <chemin-vers-votre-projet>   # crée <projet>/.orch/config.toml + les prompts système des rôles par défaut
pnpm run orch doctor --root <chemin-vers-votre-projet>   # quels agents sont installés, avec quelles capacités, autorisés ou non
```

`pnpm run orch <commande>` est le script `orch` du `package.json` **racine de ce dépôt** (`node packages/cli/dist/bin.js`) : il s'exécute depuis ici, jamais depuis le projet cible lui-même — d'où `--root <chemin-vers-votre-projet>` pour lui dire où agir. Tapé depuis un répertoire qui n'est pas une copie de ce dépôt, `pnpm run orch …` échoue immédiatement (`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`) : ce script n'existe que dans le `package.json` racine de ce monorepo, nulle part ailleurs.

`orch doctor` inspecte le catalogue et croise avec la politique effective. Exemple réel, sur une machine où les cinq agents sont installés :

```
$ pnpm run orch doctor --root <chemin-vers-votre-projet>
agent        binaire                    version              capacités                                          politique
-----------  -------------------------  -------------------  --------------------------------------------------  -----------------------------
codex        /Users/…/bin/codex         codex-cli 0.146.0    lecture-seule native, schéma de sortie, …            autorisé
antigravity  /Users/…/bin/agy           1.1.11               lecture-seule native, schéma de sortie, …            autorisé
opencode     /Users/…/bin/opencode      1.18.15               reprise, choix du modèle, mcp:project-config        autorisé
copilot      /Users/…/bin/copilot       GitHub Copilot 1.0.78 lecture-seule native, reprise, …                    autorisé
claude       /Users/…/bin/claude        2.1.226 (Claude Code) lecture-seule native, reprise, …                    refusé (récursion désactivée)
```

`packages/cli/package.json` déclare aussi un binaire `orch` (`bin: { orch: "./dist/bin.js" }`) : une fois publié, ou lié dans vos propres projets par les moyens habituels de pnpm, `orch <commande>` fonctionne directement sur le `PATH`, lancé **depuis le projet cible** — plus besoin de `--root` ni de revenir dans ce dépôt, `resolveRoot` remonte alors automatiquement jusqu'au premier `.orch/` ou `.git/` trouvé depuis le répertoire courant. **C'est le cas que suppose le reste de ce document** (`orch <commande>`, tapé depuis le projet cible) ; substituez `pnpm run orch <commande> --root <chemin-vers-votre-projet>` si vous travaillez depuis une copie non liée de ce dépôt, comme ci-dessus.

Toute commande accepte `--root <dir>` (racine explicite du projet ; par défaut, recherche automatique de `.orch/` ou `.git/` en remontant depuis le répertoire courant). La plupart acceptent aussi `--json` (sortie machine, sans couleur ni mise en forme) — deux exceptions : `orch mcp serve` ne le connaît pas du tout (`unknown option`, cette commande ne doit rien écrire d'autre que le protocole MCP sur stdout) ; `orch config` le refuse explicitement (TUI interactif, il n'y a pas de sortie machine à produire).

## Usage en ligne de commande

`orch run` est l'aller-retour complet : délègue, attend, rend le rapport. Exemple réel (agent Codex, isolation sur un worktree jetable) :

```
$ orch run --agent codex --isolation worktree "Crée un fichier hello.txt contenant exactement OK"

  [démarrage] agent "codex"
  [outil] shell — wc -c hello.txt && od -An -t x1 hello.txt … (succeeded)

Tâche t_680818a6a92047a2b08bb904e46d8427 — statut : succeeded (rapport via "schema")
Le fichier hello.txt a été créé avec exactement les deux octets « OK », sans saut de ligne final.
Fichiers modifiés (d'après git) :
  - created hello.txt
Isolée dans un worktree : "orch diff t_680818a6a92047a2b08bb904e46d8427" pour voir le diff, "orch apply t_680818a6a92047a2b08bb904e46d8427" pour l'intégrer.
```

En isolation `worktree`, rien ne touche le dépôt principal tant que vous ne l'avez pas décidé :

```
$ orch diff t_680818a6a92047a2b08bb904e46d8427
diff --git a/hello.txt b/hello.txt
new file mode 100644
index 0000000..a0aba93
--- /dev/null
+++ b/hello.txt
@@ -0,0 +1 @@
+OK
\ No newline at end of file

$ orch apply t_680818a6a92047a2b08bb904e46d8427
Tâche "t_680818a6a92047a2b08bb904e46d8427" appliquée au dépôt principal.
```

`orch run` accepte `--role <name>` (choisit l'agent via un rôle configuré et sa chaîne de repli — voir `orch role list`) ou `--agent <id>` (fixe l'agent, l'emporte sur `--role`), `--mode read-only|write`, `--isolation inplace|worktree|auto`, `--timeout 10m`, `--model <id>`, `--context <texte ou @fichier>`, `--network auto|on|off` (voir « Agents pris en charge » ci-dessus), et `--channel` (ouvre le canal retour MCP bidirectionnel : le sous-agent peut poser une question à l'agent principal en cours de route plutôt que de deviner — voir `docs/protocol.md`). Au moins l'un de `--agent`/`--role` est requis.

Ce qu'`orch` n'expose pas se passe après `--`, tel quel, en fin de ligne de commande de l'agent :

```bash
orch run --agent codex "…" -- --enable feature_x
```

Le séparateur est obligatoire : sans lui, un opérande en trop reste une coquille et `orch` le refuse plutôt que de l'envoyer à l'agent. Volontairement absent du tool MCP `orch_delegate` — c'est un geste que vous tapez, pas une latitude laissée à l'orchestrateur, qui pourrait sinon élever seul les privilèges d'un sous-agent.

Les autres sous-commandes : `orch ps` (tâches en cours et récentes), `orch logs <id> [--raw] [--follow]`, `orch cancel <id>`, `orch agents list|enable|disable|test` (`test` lance une micro-tâche réelle en lecture seule pour vérifier qu'un agent répond — `--yes` obligatoire, ça consomme son quota), `orch policy show|allow|deny`, `orch role list|show|add|remove`, `orch protocol schema <task|report|event> [--strict]` (publie le standard en JSON Schema). Celles qui modifient (`policy allow|deny`, `agents enable|disable`, `role add|remove`) acceptent `--global`/`--local` pour cibler une autre couche que le projet — voir « Configuration en couches » ci-dessous.

## Usage depuis Claude Code

Enregistrez le serveur MCP auprès de Claude Code :

```bash
orch mcp install claude --root <votre-projet>
# exécute : claude mcp add orch -- orch mcp serve --root <votre-projet>
```

`orch mcp install` fonctionne aussi avec `codex`, `copilot`, `opencode` et `antigravity` (installation en sous-commande native pour `claude`/`codex`, en fichier de configuration fusionné pour les trois autres — `--dry-run` montre ce qui serait fait sans rien exécuter ni écrire). Une fois enregistré, Claude Code expose dix tools préfixés `mcp__orch__` (`orch_delegate`, `orch_await`, `orch_status`, `orch_logs`, `orch_cancel`, `orch_diff`, `orch_apply`, `orch_list_agents`, `orch_list_roles`, `orch_answer`) — le détail de chacun est dans `packages/mcp-server/src/tools/*.ts`.

C'est ce qui rend une délégation aussi naturelle qu'invoquer un sous-agent natif : ce dépôt fournit trois sous-agents Claude Code prêts à l'emploi dans `.claude/agents/`, qui s'appuient sur ces tools :

- **`orch-implementer`** — délègue une implémentation à un agent externe sur un worktree jetable, et rend le diff pour décision. N'applique jamais de son initiative.
- **`orch-reviewer`** — délègue une relecture en lecture seule, rend les constats triés par sévérité. Ne modifie rien.
- **`orch-race`** — lance la même tâche sur plusieurs providers en parallèle, attend l'ensemble, compare leurs diffs. C'est l'usage que l'asynchronisme de `orch_delegate`/`orch_await` rend possible et qu'aucun sous-agent natif ne sait faire seul.

Dans Claude Code, il suffit de demander : *« délègue à Codex l'implémentation de X »* ou *« lance orch-race sur cette tâche avec codex et antigravity »* — le sous-agent adapté enchaîne lui-même `orch_delegate` → `orch_await` → présentation du rapport et du diff, sans bloquer la conversation principale pendant que le sous-agent externe tourne.

## Configuration en couches : global, projet, local

Trois niveaux, du plus général au plus spécifique — le plus spécifique l'emporte, champ par champ :

| Niveau | Fichier | Versionné |
|---|---|---|
| global | `~/.config/orch/config.toml` | non — propre au poste |
| projet | `<projet>/.orch/config.toml` | oui, partagé avec l'équipe |
| local | `<projet>/.orch/config.local.toml` | non — propre au poste (voir `.gitignore` plus bas) |

Poser sa politique, ses rôles et ses agents une fois dans le global fait que chaque nouveau projet en hérite sans rien faire :

```bash
orch init --global                 # crée ~/.config/orch/config.toml à partir des réglages par défaut
orch policy deny copilot --global  # s'applique désormais à tous les projets de ce poste
```

Les commandes qui modifient — `orch policy allow|deny`, `orch agents enable|disable`, `orch role add|remove` — acceptent `--global`/`--local` pour cibler une couche autre que le projet (le défaut, sans option). Mutuellement exclusifs : `orch` refuse explicitement `--global` et `--local` ensemble plutôt que de laisser le dernier lu l'emporter en silence. Chaque écriture ne touche **que** la couche visée, et ce fichier ne contient que ce que cette couche déclare en propre — jamais la fusion : un fichier de configuration lu par `orch` (dont `orch policy show`) additionne toujours les trois couches, mais écrire ne réécrit jamais ce résultat fusionné dans une seule d'entre elles. C'est précisément ce qui manquait avant : un seul `orch policy deny copilot` recopiait la configuration effective (défauts compris) dans le fichier du projet, figeant `max_parallel` et tout le reste au passage — modifier ensuite le fichier global n'avait alors plus aucun effet sur ce projet.

**Modifier une liste (`allowed`/`denied`) matérialise cette liste dans la couche visée.** Ces deux listes se fusionnent par remplacement, pas par union : une couche qui les déclare remplace entièrement celles des couches moins spécifiques. `orch policy deny X` écrit donc la liste **effective** (celle qu'`orch policy show` affiche) augmentée de `X`, jamais `X` seul — sans quoi la commande effacerait silencieusement ce que le global y avait déjà placé. Quand la couche visée ne déclarait pas encore ce champ, `orch` le dit : elle en prend désormais la main, et modifier ensuite une couche moins spécifique n'aura plus d'effet dessus.

```
$ orch policy deny copilot --global
$ orch init
$ orch policy deny opencode
Agent "opencode" ajouté à la liste "denied" (couche projet (.orch/config.toml)).
Attention : la liste "denied" n'était pas déclarée par la couche projet (.orch/config.toml) ; elle en prend désormais la main avec la valeur effective actuelle (copilot, opencode) — modifier une couche moins spécifique (global ou défaut) n'affectera plus ce champ ici.
```

À l'issue de ce scénario, `.orch/config.toml` ne contient **que** `denied = ["copilot", "opencode"]` — aucun défaut recopié, aucun réglage global figé ; modifier ensuite `max_parallel` dans le fichier global continue de se répercuter dans ce projet. `orch policy show` indique la provenance de chaque valeur (`global`, `project`, `local`, ou `default`), et `orch role show`/`orch agents list` l'étendent aux rôles et aux agents.

`orch init` crée la couche **projet** : les prompts système par défaut (`.orch/roles/*.md`) et complète le `.gitignore` du projet avec `.orch/config.local.toml`, `.orch/tasks/`, `.orch/wt/` et `.orch/state/` (n'ajoute que les lignes absentes, ne réécrit jamais le fichier depuis rien ; ne fait rien, en le disant, si le répertoire n'est pas un dépôt git). `orch init --global` crée la couche **globale**, intégralement à partir des réglages par défaut. Les deux refusent d'écraser une configuration existante sans `--force`.

## Interface de configuration

`orch config` lance un TUI (OpenTUI) pour éditer politique, rôles et intégrations MCP interactivement. Il a une exigence propre : **il tourne sous Bun**, pas sous Node — OpenTUI rend via le FFI de Bun, indisponible sur Node 24. Sans `bun` sur le `PATH`, `orch config` explique la situation et renvoie vers les sous-commandes équivalentes plutôt que d'échouer sèchement :

```
$ orch config
Le TUI de configuration exige Bun : OpenTUI rend via son FFI, que Node 24 ne permet pas […]. "bun" est introuvable dans le PATH.
Installez Bun (https://bun.sh), ou utilisez les sous-commandes équivalentes :
  - orch policy show   Politique effective (allow/deny, provenance).
  - orch role list     Rôles, agents de repli, agent retenu aujourd'hui.
  - orch agents list   Catalogue des agents : présence, capacités, autorisation.
```

`@orch/core` reste dans tous les cas la seule source de vérité de la configuration — les trois couches ci-dessus, fusionnées : le TUI, ces sous-commandes et le serveur MCP en sont des façades différentes, aucune ne la relit ni ne la réécrit pour son propre compte.

## Exécutable autonome

`orch` se construit aussi en un seul binaire, sans Node, ni Bun, ni `node_modules` requis sur la machine cible : `bun build --compile` embarque le runtime Bun, le CLI et le TUI (OpenTUI et son cœur natif compris) dans un unique fichier.

```bash
pnpm run build:binary   # équivalent à scripts/build-binary.sh — construit dist-bin/orch
```

Produit `dist-bin/orch` (répertoire ignoré par git ; ~70 Mo, Bun et OpenTUI embarqués). Utilisable directement, sans installation :

```bash
dist-bin/orch doctor
dist-bin/orch mcp serve --root <projet>
dist-bin/orch config --root <projet>
```

Ce binaire embarque Bun : l'arbitrage initial du projet (« Node partout, Bun pour le seul TUI », justifié par le serveur MCP qui doit pouvoir tourner sans Bun) ne s'applique plus à lui — `orch config` y monte directement le TUI dans le processus courant plutôt que de chercher un `bun` externe, et `orch run --channel` s'auto-invoque (`orch channel serve --task-dir <dir>`, une sous-commande interne masquée de l'aide) plutôt que de résoudre `@orch/mcp-channel` par `node_modules`, absent d'un binaire compilé. Le chemin Node décrit dans le reste de ce document (`pnpm run orch`, `pnpm exec tsc -b`) reste celui du développement quotidien dans ce monorepo, et continue de fonctionner à l'identique — ces deux comportements ne s'activent que dans le binaire, jamais sous Node.

**Compilation croisée** (`--target=bun-linux-x64` et consorts, via `scripts/build-binary.sh --target=bun-linux-x64`) : échoue aujourd'hui — OpenTUI dépend d'un paquet de binaires natifs par plateforme (`@opentui/core-<plateforme>`), dont pnpm n'installe que celui de la machine courante. Produire un binaire pour une autre plateforme suppose de relancer l'installation pnpm sur cette plateforme (ou dans un environnement qui la cible) avant de compiler.

## Brancher un agent hors catalogue

Un CLI qui n'est pas dans le catalogue des cinq se déclare dans `.orch/config.toml`, sans écrire de code — c'est l'adaptateur générique (`packages/core/src/registry/generic.ts`) qui construit sa ligne de commande à partir d'un gabarit :

```toml
[[agent]]
id = "mon-agent"
bin = "mon-agent-cli"
args = ["--task-file", "{{taskDir}}/task.json", "--out", "{{reportPath}}", "--cwd", "{{workspace}}", "{{prompt}}"]
cwd_mode = "process"      # "process" : le workspace est le cwd du processus. "flag" : déjà porté par un jeton dans args.
network_args = ["--online"]  # facultatif : ce qu'il faut ajouter pour ouvrir le réseau.
```

Déclarer `network_args`, c'est affirmer que **sans** ces arguments le CLI est confiné : `orch` fait alors passer sa capacité réseau de « inconnu » à « pilotable », et les honore selon le réglage `network` de la tâche. Sans eux, `orch doctor` annonce « réseau inconnu » et ne promet rien — ni ouverture, ni fermeture.

Les jetons `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}` et `{{model}}` sont substitués ; un jeton sans valeur (`{{model}}` si aucun `--model` n'a été demandé, par exemple) fait disparaître l'argument entier plutôt que de laisser un `undefined` résiduel. Un agent générique n'a par défaut aucune capacité déclarée (`mcpInjection: "none"`, pas de schéma de sortie natif ni de canal MCP) : il se contente du palier de rapport le plus tolérant, celui qui n'exige que de savoir lire `$ORCH_TASK_FILE` et écrire `$ORCH_REPORT_PATH` — voir `docs/protocol.md`. C'est délibéré : le contrat minimal du standard est conçu pour être atteignable par un script de quelques lignes, pas seulement par les cinq agents nommément supportés.

## Le standard

Le contrat qui permet à n'importe quel agent — supporté nommément ou générique — de recevoir une mission et de rendre un compte rendu exploitable est documenté indépendamment de ce dépôt dans [`docs/protocol.md`](docs/protocol.md) : le répertoire de tâche, les variables d'environnement, la forme de `task.json`/`report.json`/`events.jsonl`, les quatre paliers de récupération du rapport, et le canal retour MCP facultatif.
