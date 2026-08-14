---
title: Dépannage
sidebar_position: 6
description: Onze entrées symptôme, cause et remède pour les refus et constats que vous êtes le plus susceptible de rencontrer.
---

{/* Source: .claude/skills/caesar/references/troubleshooting.md — manual resync */}

# Dépannage

La plupart de ce que vous rencontrerez ici est un refus ou un constat qui nomme déjà son propre correctif dans son propre message — lisez-le avant de le contourner. Chaque entrée ci-dessous énonce le symptôme tel qu'il apparaît, sa cause, et le remède.

### `inplace` refusé pour une tâche d'écriture

**Symptôme.** Rien ne s'exécute — la délégation est refusée d'emblée. Le message nomme `inplace` comme l'isolation en jeu (qu'elle ait été demandée directement ou héritée d'un rôle ou de la valeur par défaut de la policy), pointe vers le dépôt qu'il protège, et suggère quoi faire à la place.

**Cause.** Exécuter une tâche d'écriture en `inplace` signifie écrire directement sur la branche courante de l'arbre de travail, où ses modifications se mélangeraient avec celles de l'utilisateur et avec celles de toute autre tâche, au-delà du point où un diff pourrait démêler qui a fait quoi. Le refus ne se déclenche que lorsque les quatre conditions suivantes sont réunies : `inplace` a été demandé, la tâche écrit, le dépôt est un dépôt git utilisable, et `allow_inplace_write` n'a pas été activé. Retirez-en une seule et il n'y a plus rien à refuser — une tâche `inplace` en lecture seule (la façon dont le rôle `reviewer` fourni s'exécute par défaut) n'est pas concernée, et une tâche d'écriture dans un espace de travail qui ne peut offrir aucun worktree ne l'est pas non plus.

**Remède.** Gardez l'isolation à `worktree` ou `auto`. Quand le worktree lui-même se révèle inutilisable parce que des fichiers non suivis manquent, le correctif consiste à les déclarer sous `[worktree]` — couvert dans l'entrée suivante — pas à changer d'isolation. `[policy] allow_inplace_write = true` existe pour les dépôts qui acceptent ce mélange délibérément ; cela ne masque pas un worktree incomplet.

Voir [L'atelier : les worktrees](./guides/worktrees.md) pour comprendre pourquoi l'isolation se comporte ainsi par défaut.

### Le worktree semble vide ; rien ne s'installe ni ne s'exécute

**Symptôme.** Soit un constat de faible sévérité — quelque chose comme *worktree without a workshop* — listant les chemins dont le projet semble avoir besoin, soit une tâche qui échoue sans raison évidente, son propre rapport pointant une dépendance manquante.

**Cause.** Seuls les fichiers suivis par git se retrouvent dans un worktree. `node_modules`, `.venv`, `target`, `.env`, et tout autre répertoire ignoré n'y sont tout simplement pas.

**Remède.** Listez les chemins manquants sous `[worktree] copy` dans `.caesar/config.toml` (ajoutez aussi la commande d'installation à `setup`), ou laissez `caesar init --force` les détecter pour vous. Passer à `inplace` n'est jamais la réponse.

Trois constats apparentés méritent d'être reconnus au premier coup d'œil : un chemin `[worktree]` qui ne peut pas être placé nomme l'une de quatre raisons (absent, suivi par git, ni suivi ni ignoré, ou déjà présent) plus la clé à corriger ; un chemin placé via `link` reçoit à la place une note informative, puisque partager le répertoire avec l'espace de travail signifie qu'il n'est pas vraiment isolé ; et un avertissement sur `.caesar/wt/` manquant de `.gitignore` signifie que ce fichier a été réécrit sans cette ligne — anodin, et `caesar init --force` la remet en place.

### Le diff est vide alors que l'agent affirme avoir écrit des fichiers

**Symptôme.** Le rapport affirme que des fichiers ont été modifiés, pourtant `caesar_diff` renvoie `is_empty: true` sans aucun patch.

**Causes, par ordre de probabilité.**

1. **Aucun worktree n'existe pour établir un diff — la tâche s'est exécutée en `inplace`.** Par construction, il n'y a rien à quoi comparer ; tout ce qui a changé se trouve dans l'arbre de travail lui-même. Le statut enregistré de la tâche montre quelle isolation s'est réellement appliquée, et ce n'est pas toujours celle demandée : un provider sans mode lecture seule natif est forcé vers un worktree même pour une tâche en lecture seule, et un worktree est carrément refusé quand git ne peut en fournir aucun.
2. **Les chemins modifiés appartiennent à l'orchestrateur, pas à l'agent.** Tout ce qui est matérialisé depuis `[worktree] copy`/`link` est retiré du diff, préfixe compris — une modification faite dans `node_modules`, par exemple, n'apparaîtra tout simplement pas.
3. **Rien n'a réellement été écrit.** La liste de fichiers dans le rapport n'est que l'affirmation du sous-agent lui-même ; le diff enregistre ce qui s'est réellement passé. Dans un dépôt git, les deux sont comparés, et tout écart se transforme en un constat qui mérite d'être lu.

Committer à l'intérieur du worktree n'explique pas, à lui seul, un diff vide : la comparaison se fait toujours par rapport au commit figé à la création du worktree, jamais par rapport à `HEAD`, donc que ce soit committé ou non, le résultat est identique.

### L'agent est refusé

**Symptôme.** Au lieu d'un identifiant de tâche, l'appel de délégation renvoie une erreur qui nomme à la fois l'agent et la règle qui l'a arrêté.

**Cause et remède.** Quatre règles sont vérifiées, dans un ordre fixe, et chacune a son propre correctif — voir [Configuration](./reference/configuration.md#the-four-refusal-rules) pour le tableau complet. `denied` se lève avec `caesar agents enable <id>` ; un échec `allowlist` se lève avec `caesar policy allow <id>` ; `recursion` — le blocage par défaut sur `claude` — ne se lève qu'une fois `allow_recursion` activé à la main ; `depth` n'a rien à voir avec l'agent, cela signifie que la chaîne de délégation a déjà atteint `max_depth`.

**Visez la bonne couche.** Exécutez `caesar policy show` pour voir d'où vient réellement chaque valeur. Écrire dans la couche projet ne lèvera pas un refus déclaré globalement — cela copierait plutôt la liste effective, toujours refusante, dans le fichier projet. Pointez `--global` ou `--local` vers la couche qui déclare réellement la règle.

### Réseau non garanti

**Symptôme.** Un constat informatif appelé *network not guaranteed*, ou un champ `network_warning` accompagnant le résultat de la délégation.

**Causes.** Trois situations différentes le produisent, et le libellé permet de les distinguer :

- le provider n'ouvre le réseau qu'en mode écriture — le bac à sable de `codex` le coupe en mode lecture seule sans moyen de contourner cela ; sous `auto`, la tâche se poursuit simplement sans réseau ;
- fermer le réseau a été demandé, mais caesar n'a aucun moyen connu de le fermer pour ce provider en particulier, donc il le signale plutôt que de prétendre à une fermeture qui n'a jamais eu lieu ;
- le réseau était requis (`on`) sur un provider dont caesar ne peut pas vérifier le confinement — déclarer `network_args` pour cet agent est ce qui lui apprend à ouvrir le réseau délibérément.

**Remède.** Quand l'objectif ne peut vraiment pas avancer hors ligne, demandez `network: "on"` explicitement : la délégation refuse alors carrément avant même de démarrer, plutôt que de dépenser tout son budget sur une installation qui n'allait jamais fonctionner. Quand il peut avancer hors ligne, régler `network = "off"` sur le rôle énonce clairement cette intention et l'avertissement cesse d'apparaître.

### Une tâche reste `running` indéfiniment après un `kill -9`

**Symptôme.** `caesar ps` n'arrête jamais d'appeler une tâche `running` ; `caesar watch` la suit indéfiniment ; son worktree reste là, jamais collecté.

**Cause.** Écrire le statut final d'une tâche est le travail du processus qui l'exécute, fait dans le cadre de son propre nettoyage. Un processus tué net — `kill -9`, une session fermée en cours d'exécution, une machine qui s'éteint — n'atteint jamais cette étape, donc l'enregistrement reste bloqué à `running` indéfiniment, et un worktree rattaché à une tâche `running` est exempté de collecte.

**Remède.** Lire l'état d'une tâche déclenche d'abord un balayage, automatiquement : `caesar ps` et les outils status/await vérifient tous la présence de tâches abandonnées avant de répondre. Une fois que le processus enregistré d'une tâche ne peut plus être retrouvé, elle est marquée `failed` (avec un rapport expliquant ce qui s'est passé) et son worktree est libéré pour la collecte ; `caesar gc` exécute le même balayage avant de collecter. Cela ne se déclenche jamais que sur une preuve positive — un pid qui a réellement disparu — jamais sur une simple absence d'activité, donc une tâche sans aucun marqueur de processus reste intacte face à lui. `caesar cancel <id>` est toujours là pour le cas manuel.

### En attente d'un emplacement `max_parallel`

**Symptôme.** La délégation ne démarre tout simplement pas ; `caesar run` affiche combien de tâches sont déjà en cours, la limite actuelle, et qui détient chaque emplacement.

**Cause.** `policy.max_parallel` — 4 sauf configuration contraire — n'est pas une limite par processus mais une limite partagée, appliquée via des fichiers d'emplacement sous `.caesar/state/slots/` dans lesquels puise chaque délégation contre la même racine de projet.

**Remède.** Attendez que ça passe, réduisez le lot pour tenir sous la limite, ou augmentez `max_parallel` à la couche qui a du sens. Un processus tué laisse son fichier d'emplacement orphelin, mais ce n'est pas un blocage permanent : le prochain appelant à trouver tous les emplacements occupés vérifie chaque détenteur à son tour et récupère celui dont le processus a réellement disparu.

### `workspace_warning` sur une délégation

**Symptôme.** La délégation réussit tout de même, mais un avertissement l'accompagne : la racine contre laquelle caesar délègue ne correspond pas au dépôt auquel appartient le répertoire courant.

**Cause.** `--root` est fixé une fois pour toutes, au moment de l'enregistrement MCP. Déplacez ensuite le répertoire de travail vers un autre dépôt — ou un autre worktree — et les sous-agents continuent de travailler dans un arbre que plus rien ne surveille.

**Remède.** Enregistrez-vous à nouveau depuis le dépôt réellement visé (`caesar mcp install`), ou démarrez le serveur pointé directement dessus (`caesar mcp serve --root <repo>`). Cela reste un avertissement plutôt qu'un refus, puisque le répertoire courant du serveur ne prouve rien sur l'intention et que bloquer la délégation pour cette raison coûterait plus cher que ça ne protège — mais ce n'est pas non plus à négliger : un diff produit dans le mauvais arbre est un diff qui ne sera jamais retrouvé.

### `status: succeeded` avec un rapport qui dit `failed`

**Symptôme.** Le côté processus de la tâche indique `succeeded`, mais le rapport qu'elle a produit dit `failed`, `partial`, ou `blocked`.

**Cause.** Ces deux éléments suivent volontairement deux choses distinctes, et caesar ne les fusionne jamais en une seule : le statut du processus dit seulement que la CLI s'est terminée sans erreur, tandis que le statut du rapport est le jugement propre du sous-agent quant à savoir s'il a réellement accompli la mission. Un sous-agent qui se termine avec `0` après avoir écrit `{"status":"failed"}` est exactement ce cas de figure.

**Remède.** Regardez les deux avant de tirer une conclusion — le statut du rapport juge la mission, le diff est l'enregistrement de ce qui s'est réellement passé. `caesar run` lui-même exige déjà que les deux concordent avant de renvoyer le code de sortie `0`.

### `npx caesar` échoue : « could not determine executable to run »

**Symptôme.** Chaque appel `npx caesar …` échoue immédiatement avec le message `could not determine executable to run` propre à npm.

**Cause.** `npx` cherche quelque chose sous `node_modules/.bin`, et il n'y a rien à y trouver : `caesar` vit sur le PATH comme un binaire autonome, jamais comme une dépendance npm d'un projet quelconque.

**Remède.** Invoquez `caesar` directement. `command -v caesar` montre où se trouve le binaire ; `caesar doctor` confirme ce qu'il peut atteindre depuis là. Un résultat vide du shell indique une installation manquante, pas un problème avec le `package.json` du projet.

### `caesar gc` conserve un worktree dont le diff a déjà été appliqué

**Symptôme.** `caesar gc` conserve le worktree d'une tâche terminée — "unintegrated changes", ou "modified since its application" — alors même que le travail est manifestement déjà dans l'espace de travail.

**Cause.** Trois choses peuvent l'expliquer : le diff a atteint l'espace de travail par un autre moyen que `caesar apply` (une copie manuelle, une réimplémentation à la main), donc il n'y a jamais eu d'application à enregistrer et gc n'a aucun moyen d'en déduire une à partir du seul contenu ; ou le worktree a continué à changer après l'exécution de `caesar apply`, et c'est exactement ce changement ultérieur que gc protège ; ou l'application a eu lieu sous une version plus ancienne de caesar, avant que ce suivi n'existe.

**Remède.** `caesar diff <id>` montre exactement ce que le worktree détient encore. S'il appartient à l'espace de travail, relancez `caesar apply <id>` ; une fois réglé — ou une fois le travail connu comme intégré par d'autres moyens — `caesar gc --force` nettoie ce que gc n'a pas pu confirmer par lui-même.

## Prochaines étapes

- [Configuration](./reference/configuration.md) — les règles de policy et les réglages de worktree vers lesquels renvoient la plupart de ces entrées.
- [Référence CLI](./reference/cli.md) — les flags exacts pour `gc`, `ps`, `diff`, `apply`, `cancel`.
