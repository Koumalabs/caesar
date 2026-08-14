---
title: "The workshop: worktrees"
sidebar_position: 2
description: How caesar isolates each task on a disposable git worktree, why copy-on-write makes it cheap, and why in-place writing is refused by default.
---

{/* Source: README.md — manual resync */}

# The workshop: worktrees

A git worktree contains only **tracked** files. Installed dependencies, the `.env`, ignored directories carrying briefs or artifacts are not there: nothing installs there, nothing runs there, nothing can be verified there. On a real project, isolation can become an empty space with nothing to do in it — the fix is completing the workshop, never bypassing isolation.

## Filling in the workshop

The `[worktree]` section of `.caesar/config.toml` describes what must be brought along for the worktree to become a place to actually work:

```toml
[worktree]
copy  = ["node_modules", ".env"]   # copied — isolated from the workspace
link  = []                         # linked — shared, hence not isolated
setup = ["pnpm install --offline"] # run in the worktree, before the agent
```

`caesar init` fills it in from what it finds (`pnpm-lock.yaml`, `Cargo.toml`, `pyproject.toml`, `.env`…), and writes nothing if it finds nothing.

**`copy` rather than `link`.** On a copy-on-write filesystem — APFS, Btrfs, XFS — the copy is done by clone, and duplicates nothing until someone writes. Measured on a 975 MB `node_modules` (~100,000 files): **6.3 s and 11 MB of disk**, versus 15.0 s and 994 MB for an ordinary copy. It is not free — the tree walk still has to happen — but it is the price of real isolation, and it compares favorably to the cost of the `setup` step it avoids re-running. The copy remains a true copy from the agent's point of view: two simultaneous tasks share nothing, and what one breaks at home breaks nothing elsewhere.

`link` exists for filesystems without copy-on-write, but shares the directory with the workspace — the task's report says so in plain words.

What caesar itself put in place is removed from the diff: a copied `.env` appears neither in `caesar diff` nor in `caesar apply`. And a declared path that cannot be put in place — tracked by git, not ignored, absent — produces a finding naming the key to fix, rather than a task that fails with no visible reason.

## In-place writing is refused by default

A **write** task that requests `--isolation inplace` in a usable git repository is refused, naming the remedy. This is not an abstract precaution: it is the rule whose absence made it necessary — a sub-agent writing directly onto the user's working branch is exactly what worktree isolation exists to prevent.

:::warning If the worktree seems incomplete
The answer is completing `[worktree]`, never `--isolation inplace`. For repositories where the mixing is knowingly accepted, `allow_inplace_write = true` under `[policy]` lifts the ban — and two write tasks still cannot share the same tree at the same time, since their diffs would become unattributable.
:::

Outside a git repository, or in a repository without a single commit, no worktree is possible: `inplace` remains the only mode of operation there, and nothing is refused.

## Next steps

- [Parallel tasks](./parallel.md) — each task gets its own workshop; here is how several run at once.
- [Configuration](../reference/configuration.md) — the full `[worktree]` and `[policy]` reference.
