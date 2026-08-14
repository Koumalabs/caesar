---
title: Démarrage rapide
sidebar_position: 2
description: Une première délégation de bout en bout — run, diff, apply — et l'enregistrement de caesar comme serveur MCP pour Claude Code.
---

{/* Source: README.md — manual resync */}

# Démarrage rapide

`caesar --help` est la carte : ses commandes sont regroupées par usage — prise en main, délégation, suivi, configuration, intégration — plutôt que listées dans l'ordre de déclaration. `caesar <command> --help` donne le détail d'une seule ; la liste complète se trouve dans la [référence CLI](../reference/cli.md).

## Un aller-retour complet

`caesar run` délègue, attend, et renvoie le rapport en un seul appel. Exemple réel, avec l'agent Codex isolé sur un worktree jetable :

```
$ caesar run --agent codex --isolation worktree "Create a hello.txt file containing exactly OK"
▞▚ caesar · run ──────────────────────────────────────────────────────────────────

  ● start      agent "codex"
  ▸ tool       shell — wc -c hello.txt && od -An -t x1 hello.txt (started)
  » agent      I am creating the file with exactly two bytes, no trailing newline.
  ▸ tool       shell — wc -c hello.txt && od -An -t x1 hello.txt (succeeded)
  ~ file       created hello.txt

✓ Task t_680818a6 — status: succeeded (report "success" via "schema")
  The hello.txt file was created with exactly the two bytes "OK", no trailing newline.

Files modified (according to git)
  ~ created hello.txt

Isolated in a worktree: "caesar diff t_680818a6" to see the diff, "caesar apply t_680818a6" to integrate it.
```

Un outil apparaît **dès qu'il démarre**, pas seulement à la fin, et ce que dit l'agent s'affiche en flux au fur et à mesure.

## Relire, puis intégrer

Sous isolation `worktree`, rien ne touche le dépôt principal tant que vous n'en avez pas décidé ainsi :

```
$ caesar diff t_680818a6a92047a2b08bb904e46d8427
diff --git a/hello.txt b/hello.txt
new file mode 100644
index 0000000..a0aba93
--- /dev/null
+++ b/hello.txt
@@ -0,0 +1 @@
+OK
\ No newline at end of file

$ caesar apply t_680818a6a92047a2b08bb904e46d8427
Task "t_680818a6a92047a2b08bb904e46d8427" applied to the main repository.
```

`caesar run` accepte `--role <name>` (choisit l'agent via un rôle configuré et sa chaîne de repli) ou `--agent <id>` (fixe l'agent, l'emporte sur `--role`), `--mode read-only|write`, `--isolation inplace|worktree|auto`, `--timeout 10m`, `--model <id>`, `--context <text or @file>`, `--network auto|on|off`, et `--channel` (ouvre le canal de retour MCP bidirectionnel pour que le sous-agent puisse poser une question en cours de route plutôt que de deviner). Au moins un de `--agent`/`--role` est requis.

:::tip Passer des flags directement à l'agent
Ce que caesar n'expose pas se place après `--`, tel quel, à la fin de la ligne de commande de l'agent lui-même :

```bash
caesar run --agent codex "…" -- --enable feature_x
```

Le séparateur est obligatoire : sans lui, un opérande égaré est traité comme une faute de frappe et refusé plutôt qu'envoyé à l'agent.
:::

## L'intégrer à Claude Code

Enregistrez caesar comme serveur MCP pour que Claude Code puisse déléguer directement :

```bash
caesar mcp install claude --root <your-project>
# runs: claude mcp add caesar -- caesar mcp serve --root <your-project>
```

Une fois enregistré, Claude Code expose dix outils préfixés `mcp__caesar__`. Voir [Utiliser caesar depuis Claude Code](../guides/claude-code.md) pour le tableau complet, y compris la skill et les commandes qui apprennent à l'agent principal comment les diriger.

## Prochaines étapes

- [Déléguer des tâches](../guides/delegating.md) — les groupes de commandes et comment bien briefer un sous-agent.
- [L'atelier : les worktrees](../guides/worktrees.md) — comment fonctionne réellement l'isolation.
- [Suivre des sous-agents](../guides/watch.md) — suivre une délégation en direct.
