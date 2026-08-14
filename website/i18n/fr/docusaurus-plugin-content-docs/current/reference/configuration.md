---
title: Configuration
sidebar_position: 2
description: Les trois fichiers de configuration en couches et comment ils fusionnent, plus la référence complète de [policy], [worktree], [models], [[role]] et [[agent]].
---

{/* Source: .claude/skills/caesar/references/config.md, README.md §Layered configuration: global, project, local — manual resync */}

# Configuration

## Trois couches, la plus spécifique gagne

| Couche | Fichier | Suivie |
|---|---|---|
| globale | `~/.config/caesar/config.toml` | non — par poste de travail |
| projet | `<root>/.caesar/config.toml` | oui — partagée avec l'équipe |
| locale | `<root>/.caesar/config.local.toml` | non — par poste de travail, par projet |

Elles fusionnent dans cet ordre au chargement. Un fichier manquant n'est jamais une erreur : les valeurs par défaut seules constituent une configuration fonctionnelle. Régler policy, rôles et agents une fois dans la couche globale signifie que chaque nouveau projet en hérite sans rien faire — `caesar init --global` crée cette couche, entièrement à partir des réglages par défaut.

## Comment la fusion fonctionne

La fusion n'est pas uniforme, et la différence compte au moment d'éditer :

- **`[policy]` et `[worktree]` fusionnent champ par champ.** Une couche qui ne déclare que `max_parallel` ne dit rien des autres champs, qui gardent la valeur de la couche moins spécifique. Chaque champ déclaré *remplace* — pour ceux à valeur de liste (`allowed`, `denied`, `copy`, `link`, `setup`), cela signifie remplacement, jamais union, afin qu'une couche locale puisse retirer une entrée héritée de la couche globale.
- **`[[role]]` et `[[agent]]` fusionnent par clé** (`name`, `id`) : une entrée remplace *entièrement* l'entrée de même clé d'une couche moins spécifique. Chaque entrée doit donc être complète par elle-même.

Écrire n'aplatit jamais la fusion en une seule couche : une configuration lue par `caesar` (y compris `caesar policy show`) additionne toujours les trois couches, mais écrire n'y réécrit jamais ce résultat fusionné dans une seule d'entre elles — un simple `caesar policy deny copilot` avait l'habitude de copier la configuration effective dans le fichier du projet, gelant `max_parallel` et tout le reste au passage. `caesar policy show`, `caesar role show` et `caesar agents list` rapportent la provenance de chaque valeur (`global`, `project`, `local`, ou `default`).

**Éditer `allowed`/`denied` prend le contrôle de toute la liste dans la couche ciblée.** Parce que ces listes remplacent plutôt qu'elles n'unissent, `caesar policy deny X` écrit la liste *effective* plus `X`, jamais `X` seul. Quand la couche ciblée ne déclarait pas ce champ auparavant, `caesar` le signale — et en prend possession, de sorte que modifier une couche moins spécifique par la suite n'a plus aucun effet ici :

```
$ caesar policy deny copilot --global
$ caesar init
$ caesar policy deny opencode
Agent "opencode" added to the "denied" list (project layer (.caesar/config.toml)).
Warning: the "denied" list was not declared by the project layer (.caesar/config.toml); it now takes ownership of it with the current effective value (copilot, opencode) — modifying a less specific layer (global or default) will no longer affect this field here.
```

À la fin de ce scénario, `.caesar/config.toml` ne contient que `denied = ["copilot", "opencode"]` — aucune valeur par défaut copiée, aucun réglage global gelé ; modifier `max_parallel` dans le fichier global par la suite continue de se propager à ce projet.

Les commandes qui modifient — `caesar policy allow|deny`, `caesar agents enable|disable`, `caesar agents set-model|unset-model`, `caesar role add|remove` — acceptent `--global`/`--local` pour cibler une couche autre que le projet (la valeur par défaut). Mutuellement exclusifs : `caesar` refuse explicitement `--global` et `--local` ensemble plutôt que de laisser le dernier lu l'emporter en silence.

`caesar init` crée la couche **projet** : les system prompts par défaut (`.caesar/roles/*.md`), le dépôt de la skill et des commandes pour les runtimes détectés, et complète le `.gitignore` du projet avec `.caesar/config.local.toml`, `.caesar/tasks/`, `.caesar/wt/` et `.caesar/state/`.

## `[policy]`

```toml
[policy]
allowed = []                 # empty: every agent not denied passes
denied = []
max_parallel = 4
default_isolation = "auto"   # "inplace" | "worktree" | "auto"
default_mode = "write"       # "read-only" | "write"
default_network = "auto"     # "auto" | "on" | "off"
default_timeout = "10m"
allow_recursion = false
allow_inplace_write = false
max_depth = 2
```

Ce sont les valeurs par défaut, en vigueur sans aucun fichier de configuration (`default_timeout = "10m"` se résout en interne en `default_timeout_ms: 600000`). Deux sont délibérément restrictives :

- **`allow_inplace_write = false`** — une tâche d'écriture ne s'exécute pas dans l'arbre de travail de l'utilisateur tant qu'un worktree est possible. La valeur inverse par défaut est ce qui, autrefois, laissait trois délégations écrire directement sur une vraie branche de travail, silencieusement.
- **`allow_recursion = false`** — refuse le provider `claude`, puisque déléguer à Claude depuis Claude est exactement la récursion contre laquelle ce réglage protège. C'est la seule règle de policy qui nomme un agent.

`default_network = "auto"` plutôt que `"on"` : `"on"` par défaut ferait échouer toute tâche en lecture seule sur `codex`, dont le bac à sable coupe le réseau hors du mode écriture — y compris les rôles `reviewer` et `investigator` fournis d'origine.

### Les quatre règles de refus {#the-four-refusal-rules}

Vérifiées dans cet ordre ; le premier refus est celui rapporté. Chacune a son propre remède, et seulement le sien — une suggestion générique « autorisez-le » est fausse pour trois des quatre.

| Règle | Condition | Remède |
|---|---|---|
| `denied` | l'agent est dans `policy.denied` | `caesar agents enable <id>` — en ciblant la couche qui déclare la liste (`--global` / `--local`). `caesar policy allow` ne le lèverait *pas* : `denied` l'emporte toujours sur `allowed`. |
| `allowlist` | `policy.allowed` est non vide et ne liste pas l'agent | `caesar policy allow <id>`. Attention : si `allowed` est vide aujourd'hui, cela transforme « tout agent non refusé » en « celui-ci seulement », refusant tous les autres dans le même geste. |
| `depth` | la profondeur de délégation actuelle est `>= policy.max_depth` | Rien par agent : c'est la profondeur de la délégation en cours, pas une propriété de l'agent. La profondeur est héritée via `$CAESAR_DEPTH`, donc un sous-agent qui délègue lui-même est compté. |
| `recursion` | `allow_recursion` est faux et l'agent est `claude` | Réglez `allow_recursion` (onglet Policy de la TUI `caesar config`, ou éditez le TOML) — il n'y a pas de sous-commande dédiée. |

Les refus surviennent avant que quoi que ce soit ne soit écrit sur disque : une délégation refusée ne laisse aucun répertoire de tâche derrière elle.

### `max_parallel`

Quatre par défaut, et appliqué **entre processus**, pas seulement à l'intérieur d'un seul. Les emplacements sont des fichiers sous `.caesar/state/slots/`, partagés par tout ce qui délègue sous la même racine de projet : six terminaux plus une conversation délégante puisent tous dans les mêmes quatre. Un processus qui n'en trouve aucun de libre attend, en le disant.

Deux limites à connaître. L'attente est un scrutin, pas une file : entre deux candidats, celui qui frappe au bon moment entre, pas celui arrivé le premier. Et récupérer un emplacement mort repose sur le pid du détenteur, ce qui ne veut rien dire entre plusieurs machines — un `.caesar/` sur un partage réseau utilisé depuis deux postes verrait les emplacements de l'autre comme vivants indéfiniment.

## `[worktree]` — l'atelier

Un worktree git ne contient que les fichiers **suivis**. Les dépendances installées, `.env`, les répertoires ignorés portant des briefs ou artefacts en sont absents — donc rien ne s'installe, rien ne s'exécute, rien ne se vérifie. C'est ce qui a fait de l'isolation une pièce vide sur des projets réels, et ce qui a fait ressembler `inplace` à la seule issue pratique.

```toml
[worktree]
copy  = ["node_modules", ".env"]    # copied — isolated from the workspace
link  = []                          # symlinked — shared, therefore NOT isolated
setup = ["pnpm install --offline"]  # run in the worktree, before the agent starts
```

`caesar init` remplit cette section à partir de ce qu'il trouve (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `package.json`, `Cargo.toml`, `poetry.lock`, `pyproject.toml`, `requirements.txt`, `go.mod`, `.env`, `.env.local`) et n'écrit rien s'il ne trouve rien.

**Préférez `copy` à `link`.** Sur un système de fichiers copy-on-write — APFS, Btrfs, XFS — la copie est un clone et ne duplique aucun octet tant que rien n'écrit. Mesuré sur un `node_modules` de 975 Mo (~100 000 fichiers, APFS) : 6,3 s et 11 Mo de disque, contre 15,0 s et 994 Mo pour une copie ordinaire. Pas gratuit, puisque l'arbre doit tout de même être parcouru, mais c'est le prix d'une isolation réelle, et cela reste favorable face à l'exécution `setup` que cela économise. Du point de vue de l'agent, un clone est une véritable copie : deux tâches simultanées ne partagent rien.

`link` existe pour les systèmes de fichiers sans copy-on-write. Il partage le répertoire avec l'espace de travail, donc deux tâches simultanées écrivent au même endroit et ce que l'une casse, elle le casse aussi pour l'espace de travail ; le rapport de la tâche l'indique explicitement comme un constat.

Les chemins sont relatifs à la racine de l'espace de travail. Les chemins absolus, les segments `..`, et tout ce qui se trouve sous `.git` ou `.caesar` sont refusés au chargement du fichier. Un chemin déclaré qui ne peut pas être placé produit un **constat**, pas un échec, en nommant la clé à corriger :

| Situation | Pourquoi c'est sauté |
|---|---|
| absent de l'espace de travail | rien à placer |
| suivi par git | le worktree a déjà sa version ; placer un lien par-dessus ferait écrire le sous-agent dans le dépôt principal |
| ni suivi ni ignoré | cela apparaîtrait dans le diff de la tâche comme le travail de l'agent, et `caesar gc` ne nettoierait plus jamais ce worktree |
| déjà présent dans le worktree | rien n'est écrasé |

Les commandes `setup` s'exécutent dans le worktree via un shell, dans l'ordre, après matérialisation et **avant** que l'agent ne démarre. Le premier échec interrompt la tâche avec la commande, son code de sortie et sa sortie. Tout ce que l'orchestrateur lui-même a placé est exclu du diff de la tâche, avec une sémantique de préfixe — un `.env` copié n'apparaît ni dans `caesar diff` ni dans `caesar apply`.

## `[models]` — modèle par défaut par agent

```toml
[models]
codex = "gpt-5.2-codex"
claude = "claude-opus-5"
```

Une clé par identifiant d'agent, natif ou déclaré. La valeur est passée à la CLI de l'agent (`-m`/`--model`, ou le jeton `{{model}}` d'un gabarit `[[agent]]`) pour chaque délégation qui ne nomme elle-même aucun modèle. Une table à part, délibérément **pas** un champ de `[[agent]]` : déclarer une entrée `[[agent]]` avec un identifiant natif remplace entièrement l'adaptateur natif, capacités comprises — un geste bien trop lourd pour une simple préférence de modèle.

Fusionnée clé par clé à travers les couches, comme les champs de `[policy]` : une couche projet qui déclare `codex` ne dit rien des autres agents. La même limite s'ensuit : une couche plus spécifique ne peut pas *annuler* une clé héritée, seulement la redéclarer — `caesar agents unset-model` retire la clé de la couche qui la déclare (elle nomme cette couche quand vous en ciblez une autre).

Un agent sans la capacité « model » (un `[[agent]]` générique dont `args` ne porte aucun `{{model}}`) : un `--model`/`model:` explicite est **refusé** avant que quoi que ce soit ne démarre ; un modèle dérivé de la configuration (rôle ou table) est abandonné avec un avertissement au lancement et un constat `info` dans le rapport — une délégation n'échoue jamais à cause d'une valeur par défaut que l'appelant n'a pas demandée. Une valeur vide est refusée au chargement : retirer une valeur par défaut signifie supprimer la clé, pas la vider.

Se règle avec `caesar agents set-model <id> <model>` / `unset-model <id>` (`--global`/`--local`, projet par défaut), s'affiche avec `caesar agents list` (la colonne `model` marque une valeur par défaut inapplicable comme `(ignored)`), et s'édite dans la [TUI](./tui.md) (touche `m` sur l'onglet Agents, champ `Model` sur l'onglet Roles).

## `[[role]]`

Un rôle est une chaîne de repli plus un ensemble de valeurs par défaut. Trois sont fournis d'origine :

| Rôle | Agents, dans l'ordre de repli | Mode | Isolation |
|---|---|---|---|
| `reviewer` | `codex`, `antigravity` | `read-only` | `inplace` |
| `implementer` | `codex`, `antigravity`, `opencode` | `write` | `worktree` |
| `investigator` | `antigravity`, `codex`, `opencode` | `read-only` | `auto` |

L'ensemble complet des champs d'un rôle est `name`, `purpose`, `agents`, `mode`, `isolation`, `network`, `timeout`, `system_prompt_file`, et un `model` optionnel. `purpose` est un énoncé d'intention d'une ligne, reproduit tel quel par `caesar role list` et `caesar_list_roles` — ce qui dit à un appelant lequel de plusieurs rôles convient réellement avant de déléguer via l'un d'eux.

Les trois ont par défaut `network = "auto"` et un timeout de `10m`, et chacun pointe vers un fichier de system prompt sous `.caesar/roles/<name>.md` — écrit par `caesar init`, et toléré comme absent (le rôle fonctionne quand même, sans system prompt).

Le system prompt d'un rôle est préfixé au `context` de la tâche, séparé par une règle horizontale. Ses `mode`, `isolation`, `network`, `model` optionnel et `timeout` complètent ce que la délégation n'a pas énoncé explicitement. La chaîne est parcourue dans l'ordre de déclaration, en sautant les agents dont le binaire n'est pas installé et les agents que la policy refuse ; `caesar role list` et `caesar_list_roles` montrent tous deux lequel serait choisi maintenant et pourquoi les candidats précédents ont été sautés.

Le `model` d'un rôle s'applique à **quel que soit l'agent que le repli élit** — les noms de modèles appartiennent à chaque provider, donc une chaîne mélangeant des providers n'a de sens qu'avec un nom qu'ils acceptent tous, ou un seul agent. Il l'emporte sur la valeur par défaut par agent de `[models]` et perd face à un `--model`/`model:` explicite.

## `[[agent]]` — câbler une CLI hors du catalogue

```toml
[[agent]]
id = "my-agent"
bin = "my-agent-cli"
args = ["--task-file", "{{taskDir}}/task.json", "--out", "{{reportPath}}", "--cwd", "{{workspace}}", "{{prompt}}"]
cwd_mode = "process"          # "process": the workspace is the process cwd. "flag": already carried by a token in args.
display_name = "My Agent"     # optional
native_read_only = true       # optional: the CLI enforces read-only itself
network_args = ["--online"]   # optional: what to add to open the network
```

Jetons substitués : `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}`, `{{model}}`. Un jeton sans valeur retire son argument entier plutôt que de laisser un résidu. `{{prompt}}` est obligatoire.

`native_read_only` est la seule capacité déclarable ici, et c'est délibéré : c'est la seule que le moteur peut honorer sans la coopération de la ligne de commande (elle décide si une tâche en lecture seule doit être isolée dans un worktree). Déclarer `network_args`, c'est affirmer que **sans** ces arguments la CLI est confinée — la capacité réseau de l'agent passe alors de « unknown » à « controllable ».

Un agent déclaré n'a sinon aucune capacité : pas de schéma de sortie natif, pas de canal MCP. Il utilise le palier de rapport le plus tolérant, qui demande seulement qu'il lise `$CAESAR_TASK_FILE` et écrive `$CAESAR_REPORT_PATH`. Voir l'[aperçu OACP](../protocol/overview.md).

## Résoudre le modèle

Le premier trouvé l'emporte :

1. `--model` explicite (`caesar run`) ou `model:` (`caesar_delegate`) ;
2. le `model` du rôle ;
3. `[models].<agent>` — recherché pour l'agent que la délégation a réellement élu ;
4. rien : la valeur par défaut propre au provider.

## Prochaines étapes

- [Référence CLI](./cli.md) — les commandes `caesar agents`, `caesar policy` et `caesar role` qui éditent ce fichier.
- [TUI](./tui.md) — éditer policy, rôles, agents et modèles interactivement.
- [Dépannage](../troubleshooting.md) — à quoi ressemble un refus, et comment le corriger.
