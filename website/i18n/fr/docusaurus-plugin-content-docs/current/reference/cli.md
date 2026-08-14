---
title: Référence CLI
sidebar_position: 1
description: Les 16 commandes de caesar, groupées par usage, avec synopsis, flags notables, et les conventions --root/--json/code de sortie partagées par toutes.
---

{/* Source: .claude/skills/caesar/references/cli.md — manual resync */}

# Référence CLI

caesar expose seize commandes, groupées comme `caesar --help` les groupe — par l'ordre dans lequel on les rencontre, pas par ordre de déclaration. `caesar <command> --help` affiche le détail de chacune. La CLI et les outils MCP de délégation sont deux façades sur le même moteur : utilisez la CLI pour ce que les outils n'exposent pas — inspecter la configuration, éditer policy et rôles, collecter les worktrees, et passer des arguments bruts à un provider.

## Invocation

`caesar` est un binaire autonome sur le PATH — jamais une dépendance du projet. `npx caesar` échoue toujours avec `could not determine executable to run`, quoi que dise le `package.json` du projet : appelez `caesar` directement. Dans le doute, `command -v caesar` dit où il vit et `caesar doctor` dit ce qu'il peut atteindre.

## Prise en main

### `init`

Synopsis : `caesar init [--force] [--global] [--agent <id>...] [--no-skills]`

Crée `<root>/.caesar/config.toml` et le system prompt par défaut pour chaque rôle, et dépose la skill pour chaque binaire `claude`/`codex`/`copilot`/`opencode`/`antigravity` trouvé sur le PATH, plus les slash-commands pour les deux runtimes qui les prennent en charge (`claude`, `opencode`).

- `--force` — écrase une configuration existante : réécrit la configuration et chaque prompt de rôle depuis zéro.
- `--global` — écrit `~/.config/caesar/config.toml` au lieu de la couche projet ; jamais committé dans git, contrairement à la couche projet.
- `--agent <id>` (répétable) — force ces cibles au lieu de la détection sur le PATH, validées contre les cinq mêmes identifiants. Sans détection et sans `--agent`, l'emplacement partagé `.agents/skills/caesar/` est tout de même déposé, prêt pour le prochain runtime non-`claude` installé.
- `--no-skills` — saute le dépôt/rafraîchissement des assets agentiques (non mémorisé d'un lancement à l'autre).

Sur un projet déjà initialisé, relancer `caesar init` **sans** `--force` ne rafraîchit que les assets : `.caesar/config.toml` et `.caesar/roles/*.md` restent inchangés au bit près (c'est ce que l'utilisateur édite) et la commande sort tout de même avec `0`. `--json` ajoute une clé `assets` (`{ targets, files, stale }`, ou `null` sous `--no-skills`) à la sortie existante, dans les deux portées.

### `doctor`

Synopsis : `caesar doctor [--verbose]`

Rapporte, par agent du catalogue : présence, version, capacités, et son statut sous la policy effective. `--verbose` ajoute le chemin du binaire et les capacités détaillées.

### `config`

Synopsis : `caesar config`

Lance la TUI de configuration interactive — voir [TUI](./tui.md). Aucun flag propre ; refuse `--json` explicitement (code de sortie 2), puisqu'une TUI interactive n'a aucune sortie machine à produire.

## Déléguer

### `run`

Synopsis : `caesar run <objective> [extra_args...] [--role <name>] [--agent <id>] [--mode <read-only|write>] [--isolation <inplace|worktree|auto>] [--network <auto|on|off>] [--timeout <duration>] [--model <model>] [--context <text or @file>] [--channel]`

Un aller-retour complet : il délègue, attend, et affiche le rapport. Au moins l'un de `--agent` / `--role` est requis ; `--agent` l'emporte sur l'agent qu'un `--role` aurait choisi, tandis que les autres valeurs par défaut du rôle s'appliquent toujours. `--context @path` lit le fichier à `path` (relatif au répertoire courant) et l'inline. `--timeout` accepte `10m`, `90s`, `1h`, ou un entier nu en millisecondes.

:::note Le `--` obligatoire
Tout ce que `caesar` n'expose pas peut être ajouté brut à la ligne de commande propre du provider, après un séparateur `--` :

```bash
caesar run --agent codex "…" -- --enable feature_x
```

Le séparateur est obligatoire. Commander ne peut pas distinguer les opérandes en trop de ce qui suit `--`, donc sans lui `caesar run "objective" typo` transmettrait silencieusement `typo` au provider ; à la place, la commande refuse avec le code de sortie 2 et nomme les arguments inattendus. Cette échappatoire est délibérément absente de `caesar_delegate` : c'est un geste qu'un humain tape, pas une latitude accordée à un modèle orchestrateur, qui pourrait sinon élever de lui-même les privilèges d'un sous-agent.
:::

### `watch`

Synopsis : `caesar watch [ids...] [--once]`

Sans id, suit toutes les tâches actuellement en cours. Sans `--once`, c'est une vue de terminal interactive qui se redessine et ne se termine pas d'elle-même — pour un humain, pas pour un programme. Avec `--once`, elle affiche un instantané unique et rend la main ; avec `--json`, elle émet du NDJSON des flux d'événements fusionnés.

## Suivre les tâches

### `ps`

Synopsis : `caesar ps [--status <statuses>]`

Sans `--status`, liste tout ce qui est encore actif plus les dix tâches les plus récemment terminées. `--status` prend une liste séparée par des virgules parmi `pending`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out` — un nom de statut inconnu est une erreur (code de sortie 2), pas un filtre silencieusement vide. Affiche le statut du processus et le statut du rapport dans des colonnes séparées, parce qu'ils répondent à des questions différentes.

### `logs`

Synopsis : `caesar logs <id> [--raw] [--follow]`

`--raw` renvoie la sortie CLI brute du provider au lieu des événements normalisés ; `--follow` suit en direct et rend la main de lui-même une fois que la tâche quitte un statut actif — il n'a pas besoin d'être interrompu.

### `cancel`

Synopsis : `caesar cancel <id>`

Envoie `SIGTERM` au pid enregistré. Sur une tâche déjà terminée, il rapporte qu'il n'y avait rien à annuler ; si le pid n'existe plus, la tâche est marquée `cancelled`.

### `diff`

Synopsis : `caesar diff <id>`

Montre ce qu'une tâche de worktree a changé, avant que quoi que ce soit n'atteigne le dépôt principal.

### `apply`

Synopsis : `caesar apply <id>`

Applique le diff d'une tâche de worktree au dépôt principal avec `git apply --3way`. Ne committe jamais et ne touche jamais aux branches.

### `gc`

Synopsis : `caesar gc [--dry-run] [--force]`

Supprime les worktrees et branches des tâches terminées. Un worktree dont le diff a été appliqué (`caesar apply`) est collecté tant que rien n'y a changé depuis l'application — l'application est enregistrée sur la tâche, donc `gc` n'a jamais à deviner. Ce qu'il conserve est exactement le travail qui n'a jamais été appliqué, ou modifié après coup : réglez-le avec `caesar diff`/`caesar apply`, ou écartez-le sciemment avec `--force`, qui supprime aussi les worktrees terminés portant des changements non intégrés. `--dry-run` montre suppressions et conservations sans rien changer.

## Configurer

### `agents`

Sous-commandes : `list`, `enable <id>`, `disable <id>`, `add <id>`, `remove <id>`, `set-model <id> <model>`, `unset-model <id>`, `test <id>`.

- `list` — le catalogue d'agents : présence, capacités, autorisation.
- `enable <id>` / `disable <id>` — acceptent les flags de portée ci-dessous.
- `add <id>` — `--bin <command>` (**requis**), `--args <template>` (défaut `{{prompt}}`), `--display-name <name>`, `--cwd-mode <process|flag>` (défaut `process`), `--read-only-native`, flags de portée.
- `remove <id>` — flags de portée.
- `set-model <id> <model>` — le modèle par défaut pour cet agent (table `[models]`) ; battu par le `model` d'un rôle, puis par un `--model` explicite.
- `unset-model <id>` — retire la clé de la couche ciblée ; nomme la couche déclarante quand vous en ciblez une autre.
- `test <id>` — `--yes` (**requis**) : le test exécute une véritable micro-tâche en lecture seule et consomme le quota du provider.

Les jetons substituables de `caesar agents add --args` sont `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}` et `{{model}}`. Le premier est obligatoire : sans lui, la CLI déclarée ne reçoit jamais l'objectif. Voir [Configuration](./configuration.md).

### `policy`

Sous-commandes : `show`, `allow <id>`, `deny <id>`.

- `show` — affiche la policy effective avec la provenance de chaque valeur.
- `allow <id>` / `deny <id>` — flags de portée.

### `role`

Sous-commandes : `list`, `show <name>`, `add <name>`, `remove <name>`.

- `list` — avec l'agent que chaque rôle choisirait aujourd'hui.
- `show <name>` — system prompt inclus.
- `add <name>` — `--purpose <text>`, `--agents <ids>` (séparés par des virgules, dans l'ordre de repli), `--mode <read-only|write>`, `--isolation <inplace|worktree|auto>`, `--network <auto|on|off>`, `--model <model>`, `--timeout <duration>`, flags de portée.
- `remove <name>` — flags de portée.

:::note Flags de portée
`--global` (la couche globale) et `--local` (la couche locale non suivie du projet) sont acceptés par toute commande qui écrit. Sans l'un ou l'autre, c'est la couche projet qui est ciblée. Ils sont mutuellement exclusifs et refusés ensemble plutôt que de laisser le dernier lu l'emporter.
:::

## Intégrer

### `mcp serve`

Synopsis : `caesar mcp serve [--root <dir>]`

Parle le protocole MCP sur stdout et rien d'autre ; les diagnostics vont sur stderr.

### `mcp install`

Synopsis : `caesar mcp install <client> [--dry-run]`

`<client>` est l'un de `claude`, `codex`, `copilot`, `opencode`, `antigravity`. `--dry-run` montre la commande qui serait exécutée ou le fichier qui serait écrit.

### `protocol schema`

Synopsis : `caesar protocol schema [name] [--strict]`

`[name]` est `task`, `report` ou `event` — sans argument, ils sont listés. `--strict` sélectionne la variante pour les sorties structurées natives (`report` uniquement). Voir la [spécification OACP](../protocol/specification.md).

## `--root` et `--json`

`--root <dir>` fixe la racine du projet et est accepté par **toutes** les commandes. Sans lui, la racine est trouvée en remontant depuis le répertoire courant jusqu'au premier `.caesar/` ou `.git/`.

`--json` produit une sortie machine sans couleur ni mise en forme, et est accepté par toutes les commandes **sauf deux** :

- `caesar mcp serve` ne connaît pas du tout le flag (`unknown option`) — cette commande ne doit écrire rien d'autre que le protocole MCP sur stdout ;
- `caesar config` le refuse explicitement avec le code de sortie 2 — elle lance une TUI interactive, donc il n'y a aucune sortie machine à produire. L'accepter silencieusement suggérerait qu'il a été honoré.

## Codes de sortie

| Code | Signification |
|---|---|
| `0` | succès |
| `1` | échec d'exécution (E/S, sous-processus, une tâche déléguée qui n'a pas réussi) |
| `2` | erreur d'usage ou de configuration (flag invalide, rôle ou agent inconnu, refus de policy, TOML malformé) |

`caesar run` **croise les deux statuts** avant de renvoyer `0` : le processus doit s'être terminé en `succeeded` *et* le rapport doit dire `success`. Un sous-agent qui écrit `{"status":"failed"}` et sort tout de même en `0` produit donc le code de sortie `1`, pas `0` — sinon un script enchaîné sur `caesar run` conclurait au succès d'une tâche que l'agent lui-même a déclarée en échec.

## Prochaines étapes

- [Configuration](./configuration.md) — les trois couches, `[policy]`, `[[role]]`, `[[agent]]`, `[models]`.
- [Outils MCP](./mcp-tools.md) — les dix outils qui exposent la délégation à un client MCP au lieu d'un terminal.
- [Dépannage](../troubleshooting.md) — à quoi ressemble un refus, et comment le corriger.
