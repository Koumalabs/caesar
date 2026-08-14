---
title: Custom agents
sidebar_position: 6
description: Declare a coding-agent CLI outside the built-in catalog in TOML, with no code, using a command-line template and substitution tokens.
---

{/* Source: README.md — manual resync */}

# Custom agents

A CLI that is not in the catalog of five built-in agents is declared in `.caesar/config.toml`, without writing code — the generic adapter builds its command line from a template:

```toml
[[agent]]
id = "my-agent"
bin = "my-agent-cli"
args = ["--task-file", "{{taskDir}}/task.json", "--out", "{{reportPath}}", "--cwd", "{{workspace}}", "{{prompt}}"]
cwd_mode = "process"      # "process": the workspace is the process's cwd. "flag": already carried by a token in args.
network_args = ["--online"]  # optional: what must be added to open the network.
```

## Substitution tokens

The tokens `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}` and `{{model}}` are substituted; a token with no value (`{{model}}` if no model was requested — by `--model`, the role, or the `[models]` table) makes the entire argument disappear rather than leaving a residual `undefined`.

The presence of `{{model}}` in `args` is also what grants the declared agent the "model" capability: without it, a configured default model is dropped (with a report finding) and an explicit `--model` is refused.

## Network capability

Declaring `network_args` is asserting that **without** these arguments the CLI is confined: caesar then promotes its network capability from "unknown" to "controllable", and honors them according to the task's `network` setting. Without them, `caesar doctor` announces "network unknown" and promises neither opening nor closing it.

:::note What a generic agent gets by default
A generic agent has no declared capability by default (no native output schema, no MCP channel): it settles for the most tolerant report tier, the one that only requires knowing how to read `$CAESAR_TASK_FILE` and write `$CAESAR_REPORT_PATH`. That is deliberate — the standard's minimal contract is designed to be reachable by a script of a few lines, not only by the five agents supported by name.
:::

## Next steps

- [Configuration](../reference/configuration.md) — the full `.caesar/config.toml` reference, including `[[agent]]`.
- [The OACP standard](../protocol/overview.md) — the file-based contract every agent, built-in or custom, has to speak.
