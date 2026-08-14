---
title: Aperçu
sidebar_position: 1
description: OACP condensé — le cycle tâche/rapport, le contrat minimal à deux variables, et un agent conforme en dix lignes de bash.
---

{/* Source: .claude/skills/caesar/references/protocol.md — manual resync */}

# Aperçu

OACP — l'Orchestrator–Agent Contract Protocol — version `1`, documents `caesar.task/v1`, `caesar.report/v1`, `caesar.event/v1`.

Le contrat repose sur le **système de fichiers**, pas sur un SDK. Aucune bibliothèque n'est requise : n'importe quel programme capable de lire et écrire du JSON peut jouer le rôle de sous-agent. C'est délibéré — un standard qui exige une dépendance n'est adopté que par les gens qui l'ont écrite.

## Le cycle

Un répertoire par tâche, dont le chemin est passé comme `$CAESAR_TASK_DIR`. L'orchestrateur écrit `task.json` et démarre le processus du sous-agent avec les variables `CAESAR_*` dans son environnement ; l'agent lit sa mission, travaille, se narre optionnellement via `events.jsonl`, et écrit `report.json` avant de sortir. L'orchestrateur lit alors ce rapport et le réconcilie avec le diff git observé.

## Le contrat minimal : deux variables

Tout le reste est une commodité. Un agent qui n'honore que deux variables d'environnement est orchestrable :

- **`CAESAR_TASK_FILE`** — où lire la mission (`task.json`).
- **`CAESAR_REPORT_PATH`** — où écrire le compte rendu du travail (`report.json`).

Le reste — `CAESAR_TASK_DIR`, `CAESAR_EVENTS_PATH`, `CAESAR_TASK_ID`, `CAESAR_AGENT`, `CAESAR_DEPTH` (profondeur de délégation, `0` pour l'agent de premier niveau — c'est ce qui fait que `max_depth` s'applique au-delà du premier niveau), `CAESAR_PROTOCOL_VERSION` — existe pour les agents qui peuvent s'en servir, jamais comme une exigence.

## Un agent conforme en dix lignes

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

Déclaré sous `[[agent]]` dans `.caesar/config.toml`, il est orchestrable sur le même pied que n'importe quel provider du catalogue :

```toml
[[agent]]
id = "my-agent"
bin = "my-agent.sh"
args = ["{{prompt}}"]
```

Les jetons substitués sont `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}` et `{{model}}`. Un jeton sans valeur retire son argument entier plutôt que de laisser un résidu ; `{{prompt}}` est obligatoire, puisque sans lui la CLI ne reçoit jamais l'objectif. `cwd_mode` (`process` / `flag`) dit si l'espace de travail est le répertoire de travail du processus ou déjà porté par un jeton dans `args`. Voir [Configuration](../reference/configuration.md) pour les autres champs de `[[agent]]`.

## Pourquoi le système de fichiers, et pas un SDK

Un fichier JSON sur disque est lisible aussi bien par un script bash, une ligne Python, qu'une CLI complète — personne n'a à se lier au propre code de caesar pour parler son protocole. `events.jsonl` suit la même logique : l'émettre est optionnel, et un agent qui n'écrit que son rapport final est parfaitement conforme — mais il sera littéralement invisible pendant qu'il travaille. Narrer sa progression est une courtoisie que le standard récompense, jamais une exigence qu'il impose.

## La spécification complète

Cette page est le contrat condensé à ce dont un implémenteur de sous-agent a besoin en premier. La [spécification complète](./specification.md) documente chaque champ de `task.json`/`report.json`/`events.jsonl`, les quatre paliers de récupération de rapport, et le canal retour MCP optionnel.
