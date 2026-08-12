# agent-orchestrateur

Un orchestrateur qui permet à un agent de code — typiquement Claude Code — de déléguer des tâches à des sous-agents **externes** (Codex, Antigravity, OpenCode, Copilot, ou même une autre instance de Claude Code) exécutés comme de simples processus CLI, exactement comme il déléguerait à un sous-agent natif.

Le problème qu'il résout : chaque CLI d'agent de code a sa propre façon de recevoir une mission, de rendre un compte rendu, de signaler qu'il a besoin d'une précision. Sans couche commune, comparer deux providers sur la même tâche, ou simplement fiabiliser un aller-retour avec l'un d'eux, veut dire réapprendre son format à chaque fois — et croire sur parole ce qu'il prétend avoir modifié. `agent-orchestrateur` normalise ce cycle : un standard de communication commun (`docs/protocol.md`), un moteur qui isole chaque tâche sur un worktree git jetable, et un recoupement systématique entre ce que l'agent déclare et ce que `git diff` constate — le diff fait foi, jamais la seule déclaration de l'agent.

Ce dépôt livre un CLI (`orch`), un serveur MCP à dix tools pour piloter tout ça depuis Claude Code (ou tout autre client MCP), un TUI de configuration, et une skill `orch` multi-runtime accompagnée de cinq commandes — ce que `orch init` dépose chez l'agent principal (Claude Code, Codex, Copilot CLI, OpenCode, Antigravity CLI) pour qu'il sache diriger `orch` plutôt que l'exécuter lui-même (voir « [Usage depuis Claude Code](#usage-depuis-claude-code) »).

## Agents pris en charge

| Agent | Identifiant | Binaire attendu | Mode headless | Réseau |
|---|---|---|---|---|
| Codex | `codex` | `codex` | `codex exec --json -s <read-only\|workspace-write> …` | en écriture seule |
| Antigravity CLI | `antigravity` | `agy` | `agy --print <prompt> --output-format stream-json --mode <plan\|accept-edits> …` | ouvert |
| OpenCode | `opencode` | `opencode` | `opencode run --format json --dir <workspace> …` | ouvert |
| GitHub Copilot CLI | `copilot` | `copilot` | `copilot --prompt <prompt> --output-format json --no-color --log-level none …` | pilotable |
| Claude Code | `claude` | `claude` | `claude --print <prompt> --output-format stream-json --verbose --permission-mode <plan\|acceptEdits> …` | ouvert |

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

pnpm run orch init   --root <chemin-vers-votre-projet>   # crée <projet>/.orch/config.toml + les prompts système + dépose la skill et les commandes des runtimes détectés
pnpm run orch doctor --root <chemin-vers-votre-projet>   # quels agents sont installés, avec quelles capacités, autorisés ou non
```

`pnpm run orch <commande>` est le script `orch` du `package.json` **racine de ce dépôt** (`node packages/cli/dist/bin.js`) : il s'exécute depuis ici, jamais depuis le projet cible lui-même — d'où `--root <chemin-vers-votre-projet>` pour lui dire où agir. Tapé depuis un répertoire qui n'est pas une copie de ce dépôt, `pnpm run orch …` échoue immédiatement (`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`) : ce script n'existe que dans le `package.json` racine de ce monorepo, nulle part ailleurs.

`orch doctor` inspecte le catalogue et croise avec la politique effective. Exemple réel, sur une machine où les cinq agents sont installés :

```
$ orch doctor
▞▚ orch · doctor ───────────────────────────────────────────────────────────────

╭─────────────┬─────────────────────────┬──────────────────────────┬───────────╮
│ agent       │ version                 │ capacités                │ politique │
├─────────────┼─────────────────────────┼──────────────────────────┼───────────┤
│ codex       │ codex-cli 0.147.0       │ net(w) ro schéma msg re… │ autorisé  │
│ antigravity │ 1.1.12                  │ net ro schéma reprise d… │ autorisé  │
│ opencode    │ 1.18.16                 │ net reprise modèle mcp   │ autorisé  │
│ copilot     │ GitHub Copilot CLI 1.0… │ net± ro reprise dirs mo… │ refusé    │
│ claude      │ 2.1.227 (Claude Code)   │ net ro reprise dirs mod… │ refusé    │
╰─────────────┴─────────────────────────┴──────────────────────────┴───────────╯

REFUSÉS PAR LA POLITIQUE
État voulu, sauf si vous en décidez autrement.
  - "copilot" : Agent "copilot" refusé : présent dans la liste "denied" de la
    politique. Autorisez-le avec "orch agents enable copilot --global".
  - "claude" : Agent "claude" refusé : allow_recursion est désactivé (déléguer à
    Claude depuis Claude Code serait une récursion). Activez "allow_recursion"
    (onglet Politique du TUI "orch config", ou éditez .orch/config.toml — aucune
    sous-commande dédiée aujourd'hui).
```

`autorisé` s'y lit en vert et `refusé` en rouge : voir « [Le thème](#le-thème) » pour ce que la couleur porte, et pour ce qui se passe quand elle n'est pas disponible. `--verbose` ajoute le chemin du binaire et les capacités en toutes lettres.

`packages/cli/package.json` déclare aussi un binaire `orch` (`bin: { orch: "./dist/bin.js" }`) : une fois publié, ou lié dans vos propres projets par les moyens habituels de pnpm, `orch <commande>` fonctionne directement sur le `PATH`, lancé **depuis le projet cible** — plus besoin de `--root` ni de revenir dans ce dépôt, `resolveRoot` remonte alors automatiquement jusqu'au premier `.orch/` ou `.git/` trouvé depuis le répertoire courant. **C'est le cas que suppose le reste de ce document** (`orch <commande>`, tapé depuis le projet cible) ; substituez `pnpm run orch <commande> --root <chemin-vers-votre-projet>` si vous travaillez depuis une copie non liée de ce dépôt, comme ci-dessus.

Toute commande accepte `--root <dir>` (racine explicite du projet ; par défaut, recherche automatique de `.orch/` ou `.git/` en remontant depuis le répertoire courant). La plupart acceptent aussi `--json` (sortie machine, sans couleur ni mise en forme) — deux exceptions : `orch mcp serve` ne le connaît pas du tout (`unknown option`, cette commande ne doit rien écrire d'autre que le protocole MCP sur stdout) ; `orch config` le refuse explicitement (TUI interactif, il n'y a pas de sortie machine à produire).

## Usage en ligne de commande

`orch --help` est la carte : les seize commandes y sont groupées par usage — démarrer, déléguer, suivre, configurer, intégrer — plutôt que listées dans leur ordre de déclaration. `orch <commande> --help` donne le détail d'une seule.

`orch run` est l'aller-retour complet : délègue, attend, rend le rapport. Exemple réel (agent Codex, isolation sur un worktree jetable) :

```
$ orch run --agent codex --isolation worktree "Crée un fichier hello.txt contenant exactement OK"
▞▚ orch · run ──────────────────────────────────────────────────────────────────

  ● départ     agent "codex"
  ▸ outil      shell — wc -c hello.txt && od -An -t x1 hello.txt (started)
  » agent      Je crée le fichier avec exactement deux octets, sans saut de ligne final.
  ▸ outil      shell — wc -c hello.txt && od -An -t x1 hello.txt (succeeded)
  ~ fichier    created hello.txt

✓ Tâche t_680818a6 — statut : succeeded (rapport "success" via "schema")
  Le fichier hello.txt a été créé avec exactement les deux octets « OK », sans saut de ligne final.

Fichiers modifiés (d'après git)
  ~ created hello.txt

Isolée dans un worktree : "orch diff t_680818a6" pour voir le diff, "orch apply t_680818a6" pour l'intégrer.
```

L'outil apparaît **dès son départ**, pas seulement à son issue, et ce que l'agent dit s'affiche au fil de l'eau. Le libellé est à largeur fixe pour que les textes s'alignent : la colonne se parcourt d'un coup d'œil, là où des préfixes entre crochets de longueur variable obligeaient à lire chaque début de ligne.

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

## L'atelier

Un worktree git ne contient que les fichiers **suivis**. Les dépendances installées, le `.env`, les répertoires ignorés portant des briefs ou des artefacts n'y sont pas : rien ne s'y installe, rien ne s'y lance, rien ne s'y vérifie. Sur un projet réel, l'isolation devenait un espace vide dans lequel il n'y avait rien à faire — et la contourner par `--isolation inplace` restait la seule issue praticable. C'est ainsi qu'un sous-agent finissait par écrire directement sur la branche de travail de l'utilisateur.

La section `[worktree]` de `.orch/config.toml` décrit ce qu'il faut emporter pour que le worktree devienne un lieu de travail :

```toml
[worktree]
copy  = ["node_modules", ".env"]   # recopié — isolé du workspace
link  = []                         # lié — partagé, donc non isolé
setup = ["pnpm install --offline"] # lancé dans le worktree, avant l'agent
```

`orch init` la remplit à partir de ce qu'il trouve (`pnpm-lock.yaml`, `Cargo.toml`, `pyproject.toml`, `.env`…), et n'écrit rien s'il ne trouve rien.

**`copy` plutôt que `link`.** Sur un système de fichiers copy-on-write — APFS, Btrfs, XFS — la copie se fait par clone, et ne duplique rien tant que personne n'écrit. Mesuré sur un `node_modules` de 975 Mo (~100 000 fichiers) : **6,3 s et 11 Mo de disque**, contre 15,0 s et 994 Mo pour une copie ordinaire. Ce n'est donc pas gratuit — le parcours de l'arborescence reste à faire — mais c'est le prix d'une isolation réelle, et il se compare à celui du `setup` qu'il évite de relancer. La copie reste une vraie copie du point de vue de l'agent : deux tâches simultanées ne partagent rien, et ce que l'une casse chez elle ne casse rien ailleurs.

`link` existe pour les systèmes de fichiers sans copy-on-write, mais partage le répertoire avec le workspace — le rapport de la tâche le dit alors en toutes lettres.

Ce qu'`orch` a lui-même posé est retiré du diff : un `.env` recopié n'apparaît ni dans `orch diff`, ni dans `orch apply`. Et un chemin déclaré qui ne peut pas être posé — suivi par git, non ignoré, absent — produit un constat nommant la clé à corriger, plutôt qu'une tâche qui échoue sans raison visible.

### L'écriture en place est refusée par défaut

Une tâche en **écriture** qui demande `--isolation inplace` dans un dépôt git utilisable est refusée, en nommant le remède. Ce n'est pas une précaution abstraite : c'est la règle que son absence a rendue nécessaire. Le refus tombe avant qu'aucun répertoire de tâche ne soit créé.

Si le worktree paraît incomplet, la réponse est `[worktree]`, jamais `inplace`. Pour les dépôts où le mélange est assumé en connaissance de cause, `allow_inplace_write = true` sous `[policy]` lève l'interdiction — et deux tâches en écriture ne peuvent alors toujours pas partager le même arbre en même temps, leurs diffs deviendraient inattribuables.

Hors dépôt git, ou dans un dépôt sans le moindre commit, aucun worktree n'est possible : `inplace` y reste le seul mode de fonctionnement, et rien n'est refusé.

## Tâches simultanées

Plusieurs agents tournent de front, chacun dans son propre atelier (`.orch/wt/<taskId>`, sur une branche nommée pour être lue — `orch/<rôle>/<objectif>-<8 car.>`). C'est le mode normal depuis Claude Code : `orch_delegate` rend la main aussitôt avec un `task_id`, on en lance plusieurs, `orch_await` récupère les résultats.

`policy.max_parallel` (4 par défaut) plafonne le tout — **y compris entre processus**. Six `orch run` dans six terminaux, plus une conversation Claude Code qui délègue : tous se partagent les mêmes créneaux, matérialisés par des fichiers sous `.orch/state/slots/`. Un `orch run` qui ne trouve pas de place attend en le disant, et nomme qui occupe :

```
$ orch run --agent codex "…"
1 tâche(s) déjà en cours sous ce projet (max_parallel = 1) — en attente d'un créneau. Ctrl-C pour renoncer.
  · pid 51820 — orch run — relire le parseur (depuis 2026-08-11T13:42:11.004Z)
```

Un processus tué (`kill -9`) laisse son fichier-créneau derrière lui : le premier appelant qui trouve tout occupé vérifie chaque détenteur et récupère ceux dont le processus n'existe plus. Une limite qui deviendrait un blocage définitif serait pire que pas de limite du tout.

Il laisse aussi sa tâche en plan. Le statut d'une tâche est écrit par le processus qui la conduit : tué — `kill -9`, session MCP fermée, machine arrêtée — il ne l'écrit jamais, et l'enregistrement reste « en cours » indéfiniment. `orch ps` et `orch gc` réconcilient cet état : une tâche dont le marqueur nomme un processus disparu passe en échec, avec un rapport qui dit ce qui s'est passé, et le worktree qu'elle retenait redevient collectable. La preuve est positive — un pid qu'on ne trouve plus — jamais déduite d'une absence : une tâche sans marqueur n'est jamais conclue d'office, et `orch cancel <id>` reste la sortie manuelle.

Deux réserves à connaître. L'attente est une scrutation, pas une file d'attente : entre deux candidats, l'ordre d'entrée n'est pas garanti. Et la reprise d'un créneau mort repose sur le pid, ce qui n'a de sens que sur une seule machine — un `.orch/` sur un partage réseau, utilisé depuis deux postes, verrait les créneaux de l'autre comme vivants indéfiniment.

## Regarder les sous-agents travailler

Une tâche déléguée n'est pas une boîte noire : `orch watch` ouvre une fenêtre sur ce qui se passe, à côté de la conversation ou du terminal qui a lancé la délégation.

```bash
orch watch                 # toutes les tâches en cours, image redessinée
orch watch t_a1b2 t_c3d4   # seulement celles-ci
orch watch --once          # une image, puis sortie
orch watch --json          # NDJSON des événements, plusieurs tâches fusionnées
```

```
▞▚ orch · watch   1 active · max_parallel 4                             17:21:20

● t_efb5914d codex        —            25s  inplace · write
  Écris trois fichiers a.txt, b.txt et c.txt, puis exécute 'sleep 8 && ls -1'…
  ▸ shell /bin/zsh -lc 'sleep 8 && ls -1' — 3s
  ~ 3 fichier(s)  ·  11 événement(s)

q ou Ctrl-C pour quitter — regarder ne modifie rien.
```

Aucun démon n'est nécessaire : le moteur écrit `events.jsonl` **pendant** l'exécution et publie l'état des tâches par des écritures atomiques. `orch watch` ne fait que lire ce qu'un autre processus écrit — la même propriété qui fait marcher `orch cancel` et le partage de `max_parallel`.

Quatre choses y sont délibérées :

- **Un outil apparaît dès son départ**, pas à son achèvement. C'est toute la différence entre voir partir un `npm install` de trois minutes et le découvrir à la troisième.
- **Le silence est affiché.** Une tâche bloquée et une tâche qui travaille sont indiscernables sans lui ; au-delà de trente secondes sans le moindre événement, la vue le dit.
- **Une question en attente passe devant tout le reste.** Un sous-agent qui attend une réponse via le canal retour ressemble exactement à un sous-agent figé.
- **Les tâches terminées restent visibles** quelques minutes, avec leur statut de rapport : une tâche qui disparaît au moment où elle finit est une tâche dont on ne saura jamais comment elle s'est terminée.

Hors terminal (redirection, `| tee`, script), pas de redessin ni de séquences ANSI : une ligne par événement, et `--json` rend du NDJSON exploitable.

Ce que chaque agent laisse voir dépend de ce que son CLI raconte, et cela varie beaucoup :

| Agent | Pendant l'exécution |
|---|---|
| `codex` | départ **et** fin de chaque commande, fichiers modifiés, ses rapports d'étape |
| `claude` | outils, résultats, texte, et un signal de réflexion en cours |
| `opencode` | outils (une fois terminés seulement — son flux n'annonce pas leur départ), texte |
| `antigravity` | son texte au fil de l'eau, ses erreurs ; ses appels d'outils ne sont pas encore traduits |
| `copilot` | texte, erreurs de session ; ses appels d'outils restent non vérifiés faute de quota disponible |

Ces traductions sont écrites d'après des captures réelles, conservées dans `packages/core/test/fixtures/` et rejouées par les tests. Là où une forme n'a pas pu être observée, l'adaptateur le dit en toutes lettres plutôt que de deviner — une branche écrite d'après une convention plausible avait laissé les appels d'outils d'opencode invisibles pendant des mois, tout en passant au vert.

Les autres sous-commandes : `orch ps` (tâches en cours et récentes), `orch logs <id> [--raw] [--follow]`, `orch cancel <id>`, `orch agents list|enable|disable|test` (`test` lance une micro-tâche réelle en lecture seule pour vérifier qu'un agent répond — `--yes` obligatoire, ça consomme son quota), `orch policy show|allow|deny`, `orch role list|show|add|remove`, `orch protocol schema <task|report|event> [--strict]` (publie le standard en JSON Schema). Celles qui modifient (`policy allow|deny`, `agents enable|disable`, `role add|remove`) acceptent `--global`/`--local` pour cibler une autre couche que le projet — voir « Configuration en couches » ci-dessous.

## Usage depuis Claude Code

Enregistrez le serveur MCP auprès de Claude Code :

```bash
orch mcp install claude --root <votre-projet>
# exécute : claude mcp add orch -- orch mcp serve --root <votre-projet>
```

`orch mcp install` fonctionne aussi avec `codex`, `copilot`, `opencode` et `antigravity` (installation en sous-commande native pour `claude`/`codex`, en fichier de configuration fusionné pour les trois autres — `--dry-run` montre ce qui serait fait sans rien exécuter ni écrire). Une fois enregistré, Claude Code expose dix tools préfixés `mcp__orch__` (`orch_delegate`, `orch_await`, `orch_status`, `orch_logs`, `orch_cancel`, `orch_diff`, `orch_apply`, `orch_list_agents`, `orch_list_roles`, `orch_answer`) — le détail de chacun est dans `packages/mcp-server/src/tools/*.ts`.

Ce qui rend une délégation aussi naturelle qu'invoquer un sous-agent natif, ce n'est pas ces tools pris isolément : c'est la skill `orch`, déposée par `orch init` chez l'agent principal, qui lui apprend à s'en servir.

### La connaissance agentique : skill et commandes

**Diriger, pas exécuter.** La skill apprend à l'agent principal — Claude Code, Codex, Copilot CLI, OpenCode ou Antigravity CLI — à briefer un exécutant externe pour une tâche précise, à en lancer plusieurs de front sans attendre l'un pour démarrer l'autre, et à ne jamais croire sur parole ce qui revient : c'est le diff qui tranche, pas le résumé du sous-agent. Cinq commandes en découlent directement, une par geste : `/orch-delegate` (une implémentation, un provider), `/orch-fanout` (plusieurs objectifs indépendants, en parallèle), `/orch-race` (le même objectif sur plusieurs providers, comparés côte à côte), `/orch-review` (une relecture en lecture seule par un provider qui n'a pas écrit le diff), `/orch-tasks` (l'état de ce qui est délégué). Dans un runtime où la skill est déposée, il suffit de demander : *« délègue à Codex l'implémentation de X »* — elle guide alors l'agent principal lui-même dans l'enchaînement `orch_delegate` → `orch_await` → présentation du rapport et du diff, sans bloquer la conversation pendant que l'agent externe tourne ; sous Claude Code, les commandes donnent le même enchaînement de façon explicite, sans dépendre du déclenchement automatique de la skill.

**Où elle s'installe** — un seul endroit gouverne cette table, `packages/core/src/agent-assets.ts`, vérifié contre chaque binaire réel :

| Cible | Skill | Commandes |
|---|---|---|
| partagé (`codex`, `copilot`, `antigravity`) | `.agents/skills/orch/` | — |
| `claude` | `.claude/skills/orch/` (copie dédiée) | `.claude/commands/` (`orch-*.md`) |
| `opencode` | `.agents/skills/orch/` (partagé) | `.opencode/commands/` (`orch-*.md`) |

Deux copies plutôt qu'une : Claude Code ne lit pas `.agents/skills/` — vérifié empiriquement sur le binaire, pas supposé depuis sa documentation — une skill posée uniquement là lui resterait invisible.

**Comment.** `orch init` détecte les runtimes présents dans le `PATH` et leur dépose (ou rafraîchit) la skill et les commandes ; si aucun n'est détecté et qu'aucun `--agent` n'est donné, le socle partagé (`.agents/skills/orch/`) est déposé quand même, prêt pour le premier runtime installé ensuite. `--agent <id>`, répétable, force la liste des cibles plutôt que la détection ; `--no-skills` coupe entièrement ce dépôt (non mémorisé, à repasser à chaque `init`). Sur un projet déjà initialisé, relancer `orch init` **sans** `--force` est un refresh : `.orch/config.toml` et `.orch/roles/*.md` restent intacts, ce sont les fichiers que l'utilisateur édite — la skill et les commandes, elles, entièrement dérivées du catalogue et n'appartenant donc à personne, sont réécrites depuis celui-ci. C'est précisément ce qui fait qu'une skill améliorée atteint un projet déjà initialisé : un simple `orch init`, rien de plus à réinitialiser. Côté `claude`, `orch init` fusionne aussi `<projet>/.claude/settings.json` : les six tools MCP qui ne modifient aucun fichier de l'utilisateur (`orch_list_agents`, `orch_list_roles`, `orch_status`, `orch_await`, `orch_logs`, `orch_diff`) sont ajoutés à `permissions.allow` s'ils n'y sont pas déjà, sans toucher au reste du fichier. Dans tous les cas, la skill ne fait qu'appeler les tools du serveur MCP `orch` : ils n'existent pour un runtime qu'une fois `orch mcp install <client>` lancé pour lui (voir ci-dessus).

**Pour les contributeurs.** Les sources de la skill et des commandes vivent en clair dans `.claude/skills/orch/` (+ 4 références) et `.claude/commands/` — le format Claude Code sert de source, les autres runtimes en reçoivent une adaptation. `pnpm run assets:sync` régénère depuis ces fichiers le catalogue embarqué (`packages/core/src/agent-assets.generated.ts`), et un test de dérive échoue si l'un des deux a été édité sans relancer l'autre : les sources et le catalogue ne peuvent pas diverger en silence. Le dépôt garde par ailleurs ses trois sous-agents Claude Code (`.claude/agents/`) pour son propre développement — ils ne sont pas déposés chez l'utilisateur et ne font pas partie de ce catalogue. Attention en éditant ces sources : ce sont exactement les chemins que `orch init` dépose/rafraîchit pour la cible `claude` dans ce dépôt même — lancer `orch init` pendant que vous les modifiez écrase vos éditions non encore synchronisées dans le catalogue. Lancez `pnpm run assets:sync` avant, ou passez `orch init --no-skills` le temps de l'édition.

## Configuration en couches : global, projet, local

Trois niveaux, du plus général au plus spécifique — le plus spécifique l'emporte, champ par champ :

| Niveau | Fichier | Versionné |
|---|---|---|
| global | `~/.config/orch/config.toml` | non — propre au poste |
| projet | `<projet>/.orch/config.toml` | oui, partagé avec l'équipe |
| local | `<projet>/.orch/config.local.toml` | non — propre au poste (voir `.gitignore` plus bas) |

Poser sa politique, ses rôles et ses agents une fois dans le global fait que chaque nouveau projet en hérite sans rien faire :

```bash
orch init --global                 # crée ~/.config/orch/config.toml + dépose skill et commandes en portée globale
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

`orch init` crée la couche **projet** : les prompts système par défaut (`.orch/roles/*.md`), le dépôt de la skill et des commandes pour les runtimes détectés (voir « [Usage depuis Claude Code](#usage-depuis-claude-code) » ci-dessus), et complète le `.gitignore` du projet avec `.orch/config.local.toml`, `.orch/tasks/`, `.orch/wt/` et `.orch/state/` (n'ajoute que les lignes absentes, ne réécrit jamais le fichier depuis rien ; ne fait rien, en le disant, si le répertoire n'est pas un dépôt git). `orch init --global` crée la couche **globale**, intégralement à partir des réglages par défaut. Sans `--force`, relancer l'une ou l'autre sur une couche déjà initialisée n'est plus un refus : la commande réussit (code 0), laisse `config.toml` et les rôles intacts, et se contente de rafraîchir la skill et les commandes — `--force` réinitialise tout depuis zéro, prompts système compris.

## Le thème

Une seule palette pour la ligne de commande **et** pour le TUI, dans `packages/theme` : elle vivait auparavant dans le TUI seul, pendant que la CLI choisissait ses couleurs au cas par cas parmi sept codes ANSI de base — les deux moitiés du même outil ne se ressemblaient pas à l'écran.

Deux règles la tiennent, et elles expliquent l'essentiel de ce qu'on voit :

- **Le texte principal ne porte jamais de couleur.** Il hérite de l'avant-plan du terminal, donc reste lisible sur fond clair comme sur fond sombre. Seuls le secondaire, le tertiaire et le sémantique (`autorisé` / `refusé`, les statuts de tâche, les statuts de rapport) sont colorés. C'est pourquoi la parole d'un sous-agent, dans `orch run`, sort en texte neutre : c'est sa marque qui est teintée, pas ce qu'il dit.
- **La couleur classe, elle ne décore pas.** Une valeur colorée est une valeur qu'on vient chercher du regard sans la lire.

### Les trois canaux

| | Structure (encadrés, bandeaux) | Couleur |
|---|---|---|
| `--json` | non | non |
| Hors terminal (tuyau, redirection, `\| tee`) | oui | non |
| Terminal | oui | oui |

`--json` reste strictement du JSON : aucune séquence ANSI, aucun bandeau, rien d'autre sur `stdout`. C'est le canal par lequel un agent consomme ce CLI, et il ne bouge pas. Un tableau encadré se découpe en revanche mal à `grep`/`awk` — c'est assumé, `--json` est fait pour ça.

### Ce qui s'adapte tout seul

- **Profondeur de couleur** : truecolor si `COLORTERM` l'annonce, sinon les 256 si `TERM` contient `256color`, sinon les 16 de base. Volontairement conservateur : une séquence 256 émise vers un terminal qui l'ignore s'affiche en clair au milieu du texte.
- **[`NO_COLOR`](https://no-color.org)** et `TERM=dumb` coupent toute couleur.
- **Locale non-UTF-8** (`LC_ALL=C`) : les traits fins et les marques retombent sur un jeu ASCII de même largeur — `+--+`, `|`, `*`, `+`, `x`. Sans ce repli, un encadré Unicode sur un terminal qui ne le lit pas est moins lisible qu'un tableau sans encadré.
- **Largeur du terminal** : le coût du cadre (`3N+1` caractères pour N colonnes) entre dans le budget, de sorte qu'aucune bordure ne se replie. Quand le cadre ne peut plus tenir, il est abandonné au profit d'une mise en page alignée, qui récupère la place qu'il coûtait.

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
