# agent-orchestrateur

Un orchestrateur qui permet à un agent de code — typiquement Claude Code — de déléguer des tâches à des sous-agents **externes** (Codex, Antigravity, OpenCode, Copilot, ou même une autre instance de Claude Code) exécutés comme de simples processus CLI, exactement comme il déléguerait à un sous-agent natif.

Le problème qu'il résout : chaque CLI d'agent de code a sa propre façon de recevoir une mission, de rendre un compte rendu, de signaler qu'il a besoin d'une précision. Sans couche commune, comparer deux providers sur la même tâche, ou simplement fiabiliser un aller-retour avec l'un d'eux, veut dire réapprendre son format à chaque fois — et croire sur parole ce qu'il prétend avoir modifié. `agent-orchestrateur` normalise ce cycle : un standard de communication commun (`docs/protocol.md`), un moteur qui isole chaque tâche sur un worktree git jetable, et un recoupement systématique entre ce que l'agent déclare et ce que `git diff` constate — le diff fait foi, jamais la seule déclaration de l'agent.

Ce dépôt livre un CLI (`orch`), un serveur MCP à dix tools pour piloter tout ça depuis Claude Code (ou tout autre client MCP), un TUI de configuration, et trois sous-agents Claude Code prêts à l'emploi dans `.claude/agents/`.

## Agents pris en charge

| Agent | Identifiant | Binaire attendu | Mode headless |
|---|---|---|---|
| Codex | `codex` | `codex` | `codex exec --json -s <read-only\|workspace-write> …` |
| Antigravity CLI | `antigravity` | `agy` | `agy --print <prompt> --output-format stream-json --mode <plan\|accept-edits> …` |
| OpenCode | `opencode` | `opencode` | `opencode run --format json --dir <workspace> …` |
| GitHub Copilot CLI | `copilot` | `copilot` | `copilot --prompt <prompt> --output-format json --no-color --log-level none …` |
| Claude Code | `claude` | `claude` | `claude --print <prompt> --output-format json --permission-mode <plan\|acceptEdits> …` |

Le détail complet des flags (schéma de sortie natif, canal MCP, modèle, répertoires additionnels…) est dans `packages/core/src/adapters/*.ts`, un fichier par agent — chaque flag y a été vérifié par `--help` sur une machine réelle, aucun n'est inventé.

Un mot sur `claude` : il figure au catalogue (déléguer d'une instance de Claude Code à une autre a du sens — relecture croisée, par exemple), mais la politique par défaut le refuse (`allow_recursion: false`) précisément parce que c'est le cas le plus susceptible de tourner en boucle. `orch agents enable claude` ou `orch policy allow claude` lève ce refus explicitement, si besoin.

## Installation et premiers pas

Monorepo pnpm, Node 24. Pas encore publié sur npm : on l'utilise depuis une copie du dépôt.

```bash
pnpm install
pnpm exec tsc -b        # build de tous les packages
```

Dans le projet où vous voulez déléguer des tâches :

```bash
pnpm run orch init      # crée <projet>/.orch/config.toml + les prompts système des rôles par défaut
pnpm run orch doctor    # quels agents sont installés, avec quelles capacités, autorisés ou non
```

`orch doctor` inspecte le catalogue et croise avec la politique effective. Exemple réel, sur une machine où les cinq agents sont installés :

```
$ pnpm run orch doctor
agent        binaire                    version              capacités                                          politique
-----------  -------------------------  -------------------  --------------------------------------------------  -----------------------------
codex        /Users/…/bin/codex         codex-cli 0.146.0    lecture-seule native, schéma de sortie, …            autorisé
antigravity  /Users/…/bin/agy           1.1.11               lecture-seule native, schéma de sortie, …            autorisé
opencode     /Users/…/bin/opencode      1.18.15               reprise, choix du modèle, mcp:project-config        autorisé
copilot      /Users/…/bin/copilot       GitHub Copilot 1.0.78 lecture-seule native, reprise, …                    autorisé
claude       /Users/…/bin/claude        2.1.226 (Claude Code) lecture-seule native, reprise, …                    refusé (récursion désactivée)
```

`pnpm run orch <commande>` fonctionne depuis la racine de ce dépôt (c'est le script `orch` du `package.json` racine, qui lance `node packages/cli/dist/bin.js`) — c'est la commande utilisée pour tous les exemples réels de ce document. `packages/cli/package.json` déclare un binaire `orch` (`bin: { orch: "./dist/bin.js" }`) : une fois le paquet publié ou lié dans vos propres projets par les moyens habituels de pnpm, `orch <commande>` fonctionne directement sur le `PATH`. Le reste de ce document écrit `orch <commande>` pour rester lisible ; substituez `pnpm run orch <commande>` si vous travaillez depuis une copie de ce dépôt sans l'avoir lié.

Toute commande accepte `--root <dir>` (racine explicite du projet ; par défaut, recherche automatique de `.orch/` ou `.git/` en remontant depuis le répertoire courant) et `--json` (sortie machine, sans couleur ni mise en forme).

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

`orch run` accepte `--role <name>` (choisit l'agent via un rôle configuré et sa chaîne de repli — voir `orch role list`) ou `--agent <id>` (fixe l'agent, l'emporte sur `--role`), `--mode read-only|write`, `--isolation inplace|worktree|auto`, `--timeout 10m`, `--model <id>`, `--context <texte ou @fichier>`, et `--channel` (ouvre le canal retour MCP bidirectionnel : le sous-agent peut poser une question à l'agent principal en cours de route plutôt que de deviner — voir `docs/protocol.md`). Au moins l'un de `--agent`/`--role` est requis.

Les autres sous-commandes : `orch ps` (tâches en cours et récentes), `orch logs <id> [--raw] [--follow]`, `orch cancel <id>`, `orch agents list|enable|disable|test` (`test` lance une micro-tâche réelle en lecture seule pour vérifier qu'un agent répond — `--yes` obligatoire, ça consomme son quota), `orch policy show|allow|deny`, `orch role list|show|add|remove`, `orch protocol schema <task|report|event> [--strict]` (publie le standard en JSON Schema).

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

`@orch/core` reste dans tous les cas la seule source de vérité de la configuration (`<projet>/.orch/config.toml`, fusionnée avec `~/.config/orch/config.toml`) : le TUI, ces sous-commandes et le serveur MCP en sont trois façades différentes, aucune ne la relit ni ne la réécrit pour son propre compte.

## Brancher un agent hors catalogue

Un CLI qui n'est pas dans le catalogue des cinq se déclare dans `.orch/config.toml`, sans écrire de code — c'est l'adaptateur générique (`packages/core/src/registry/generic.ts`) qui construit sa ligne de commande à partir d'un gabarit :

```toml
[[agent]]
id = "mon-agent"
bin = "mon-agent-cli"
args = ["--task-file", "{{taskDir}}/task.json", "--out", "{{reportPath}}", "--cwd", "{{workspace}}", "{{prompt}}"]
cwd_mode = "process"   # "process" : le workspace est le cwd du processus. "flag" : déjà porté par un jeton dans args.
```

Les jetons `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}` et `{{model}}` sont substitués ; un jeton sans valeur (`{{model}}` si aucun `--model` n'a été demandé, par exemple) fait disparaître l'argument entier plutôt que de laisser un `undefined` résiduel. Un agent générique n'a par défaut aucune capacité déclarée (`mcpInjection: "none"`, pas de schéma de sortie natif ni de canal MCP) : il se contente du palier de rapport le plus tolérant, celui qui n'exige que de savoir lire `$ORCH_TASK_FILE` et écrire `$ORCH_REPORT_PATH` — voir `docs/protocol.md`. C'est délibéré : le contrat minimal du standard est conçu pour être atteignable par un script de quelques lignes, pas seulement par les cinq agents nommément supportés.

## Le standard

Le contrat qui permet à n'importe quel agent — supporté nommément ou générique — de recevoir une mission et de rendre un compte rendu exploitable est documenté indépendamment de ce dépôt dans [`docs/protocol.md`](docs/protocol.md) : le répertoire de tâche, les variables d'environnement, la forme de `task.json`/`report.json`/`events.jsonl`, les quatre paliers de récupération du rapport, et le canal retour MCP facultatif.
