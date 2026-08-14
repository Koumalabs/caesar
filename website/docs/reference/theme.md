---
title: Theme
sidebar_position: 5
description: The caesar palette — accent gold, semantic colors, the two rules that govern them, and how a terminal's capabilities are detected automatically.
---

{/* Source: README.md §The theme, packages/theme/src/palette.ts, packages/theme/src/ansi.ts, packages/theme/src/wordmark.ts — manual resync */}

# Theme

Both the CLI and the TUI draw from one palette, defined in a single place: `packages/theme`. That consolidation is recent — the CLI used to reach for whichever of seven basic ANSI codes seemed to fit at each call site, independently of the TUI's own colors, so the two interfaces of the same tool ended up looking unrelated on screen.

## The palette

- **Accent** — `#EAA52E`, the brand gold: focus, selection, the active tab. Saturated enough to cut through, light enough to carry a dark ink (`#1A1206`) wherever it becomes a background.
- **Ramp** — a six-shade gradient, one entry per line of the wordmark (the ASCII logo), each stop darkening from the brand gold: `#EAA52E`, `#DB9A2B`, `#CC8F28`, `#BD8425`, `#AE7922`, `#9F6E1F`. It only ever darkens, never lightens toward white — a gradient trending toward white would vanish on a light-background terminal, and plenty of users run one.
- **Secondary (`DIM`)** — `#9E9284`: column headers, default values, explanations.
- **Tertiary (`FAINT`)** — `#6B6252`: inactive borders, inheritance marks, what should be read only when looked for.
- **Semantic** — `OK` `#7DCE82`, `WARN` `#E0AF68`, `BAD` `#E88388`: `allowed`/`denied`, task statuses, report statuses.

Down at the coarsest color depth (the base 16 — see below), the accent gold collapses onto the same bright yellow as `WARN`: the accepted price of a golden accent sharing a limited terminal palette with a warning color. Weight and context still tell them apart on screen.

## Two rules

- **Primary text never carries color.** It inherits the terminal's foreground, so it stays readable on light and dark backgrounds alike. Only the secondary, the tertiary and the semantic are colored. That is why a sub-agent's words, in `caesar run`, come out as neutral text: it is its badge that is tinted, not what it says.
- **Color classifies, it does not decorate.** A colored value is a value your eye goes looking for without reading it.

## The three channels

| | Structure (frames, banners) | Color |
|---|---|---|
| `--json` | no | no |
| Outside a terminal (pipe, redirection, `\| tee`) | yes | no |
| Terminal | yes | yes |

`--json` stays strictly JSON: no ANSI sequence, no banner, nothing else on `stdout`. It is the channel through which an agent consumes this CLI, and it does not move. A framed table, on the other hand, cuts up poorly under `grep`/`awk` — that is accepted, `--json` is made for that.

## What adapts on its own

- **Color depth** — truecolor if `COLORTERM` announces it, otherwise the 256 if `TERM` contains `256color`, otherwise the basic 16. Deliberately conservative: a 256 sequence emitted toward a terminal that ignores it displays in the clear in the middle of the text.
- **[`NO_COLOR`](https://no-color.org)** and `TERM=dumb` cut all color.
- **Non-UTF-8 locale** (`LC_ALL=C`) — fine rules and marks fall back on an ASCII set of the same width: `+--+`, `|`, `*`, `+`, `x`. Without this fallback, a Unicode frame on a terminal that cannot read it is less readable than a table without a frame.
- **Terminal width** — the frame's cost (`3N+1` characters for N columns) enters the budget, so that no border ever wraps. When the frame can no longer fit, it is abandoned in favor of an aligned layout, which recovers the space it cost.

## Next steps

- [TUI](./tui.md) — where this palette is at its busiest: focus, selection, inheritance marks.
- [CLI reference](./cli.md) — `--json` and the exit codes this theme system defers to outside a terminal.
