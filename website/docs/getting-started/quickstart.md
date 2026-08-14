---
title: Quickstart
sidebar_position: 2
description: A first end-to-end delegation — run, diff, apply — plus registering caesar as an MCP server for Claude Code.
---

{/* Source: README.md — manual resync */}

# Quickstart

`caesar --help` is the map: its commands are grouped by use — getting started, delegating, following, configuring, integrating — rather than listed in declaration order. `caesar <command> --help` gives the detail of a single one; the full list lives in the [CLI reference](../reference/cli.md).

## A complete round-trip

`caesar run` delegates, waits, and returns the report in one call. Real example, with the Codex agent isolated on a disposable worktree:

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

A tool appears **as soon as it starts**, not only at its end, and what the agent says streams as it happens.

## Review, then land

Under `worktree` isolation, nothing touches the main repository until you have decided it should:

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

`caesar run` accepts `--role <name>` (picks the agent via a configured role and its fallback chain) or `--agent <id>` (fixes the agent, wins over `--role`), `--mode read-only|write`, `--isolation inplace|worktree|auto`, `--timeout 10m`, `--model <id>`, `--context <text or @file>`, `--network auto|on|off`, and `--channel` (opens the bidirectional MCP return channel so the sub-agent can ask a question along the way instead of guessing). At least one of `--agent`/`--role` is required.

:::tip Passing flags straight to the agent
What caesar does not expose goes after `--`, as is, at the end of the agent's own command line:

```bash
caesar run --agent codex "…" -- --enable feature_x
```

The separator is mandatory: without it, a stray operand is treated as a typo and refused rather than sent to the agent.
:::

## Wire it into Claude Code

Register caesar as an MCP server so Claude Code can delegate directly:

```bash
caesar mcp install claude --root <your-project>
# runs: claude mcp add caesar -- caesar mcp serve --root <your-project>
```

Once registered, Claude Code exposes ten tools prefixed `mcp__caesar__`. See [Using from Claude Code](../guides/claude-code.md) for the full picture, including the skill and commands that teach the main agent how to direct them.

## Next steps

- [Delegating tasks](../guides/delegating.md) — the command groups and how to brief a sub-agent well.
- [The workshop: worktrees](../guides/worktrees.md) — how isolation actually works.
- [Watching sub-agents](../guides/watch.md) — following a delegation live.
