---
title: Agents personnalisés
sidebar_position: 6
description: Déclarez une CLI d'agent de code hors du catalogue intégré en TOML, sans code, à l'aide d'un gabarit de ligne de commande et de jetons de substitution.
---

{/* Source: README.md — manual resync */}

# Agents personnalisés

Une CLI absente du catalogue des cinq agents intégrés se déclare dans `.caesar/config.toml`, sans écrire de code — l'adaptateur générique construit sa ligne de commande à partir d'un gabarit :

```toml
[[agent]]
id = "my-agent"
bin = "my-agent-cli"
args = ["--task-file", "{{taskDir}}/task.json", "--out", "{{reportPath}}", "--cwd", "{{workspace}}", "{{prompt}}"]
cwd_mode = "process"      # "process": the workspace is the process's cwd. "flag": already carried by a token in args.
network_args = ["--online"]  # optional: what must be added to open the network.
```

## Jetons de substitution

Les jetons `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}` et `{{model}}` sont substitués ; un jeton sans valeur (`{{model}}` si aucun modèle n'a été demandé — par `--model`, le rôle, ou la table `[models]`) fait disparaître l'argument entier plutôt que de laisser un `undefined` résiduel.

La présence de `{{model}}` dans `args` est aussi ce qui accorde à l'agent déclaré la capacité « model » : sans elle, un modèle par défaut configuré est abandonné (avec un constat dans le rapport) et un `--model` explicite est refusé.

## Capacité réseau

Déclarer `network_args`, c'est affirmer que **sans** ces arguments la CLI est confinée : caesar promeut alors sa capacité réseau de « unknown » à « controllable », et les honore selon le réglage `network` de la tâche. Sans eux, `caesar doctor` annonce « network unknown » et ne promet ni de l'ouvrir ni de le fermer.

:::note Ce qu'un agent générique obtient par défaut
Un agent générique n'a aucune capacité déclarée par défaut (pas de schéma de sortie natif, pas de canal MCP) : il se contente du palier de rapport le plus tolérant, celui qui exige seulement de savoir lire `$CAESAR_TASK_FILE` et écrire `$CAESAR_REPORT_PATH`. C'est délibéré — le contrat minimal du standard est conçu pour être atteignable par un script de quelques lignes, pas seulement par les cinq agents pris en charge nommément.
:::

## Prochaines étapes

- [Configuration](../reference/configuration.md) — la référence complète de `.caesar/config.toml`, y compris `[[agent]]`.
- [Le standard OACP](../protocol/overview.md) — le contrat basé sur les fichiers que tout agent, intégré ou personnalisé, doit parler.
