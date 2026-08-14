/**
 * Entry point of the configuration TUI. `runTui` mounts the renderer on
 * the given root in the current process; exported to be imported
 * statically by `packages/cli/src/bun-entry.ts` (task 12, the entry point
 * of the standalone `caesar` binary) — it is this static import that gets
 * the TUI embedded in the Bun-compiled binary. `@caesar/tui` declares this
 * file as the `"main"` of its `package.json`: `import { runTui } from
 * "@caesar/tui"` resolves to it without detour.
 *
 * Launched directly (`bun main.tsx <root>` — the path that `caesar config`
 * spawns as a subprocess when Bun is on the `PATH`, see
 * `packages/cli/src/commands/config.ts`), this file self-invokes via
 * `import.meta.main`, the native Bun equivalent of the `isMain` guard that
 * `packages/cli/src/bin.ts` builds by hand for Node (`process.argv[1]`
 * compared to `fileURLToPath(import.meta.url)`): `runTui` therefore runs
 * only once, never a second time when this module is merely imported (by
 * `bun-entry.ts`, or by a test that would read this file).
 *
 * `exitOnCtrlC: false`: by default, `CliRenderer` intercepts Ctrl+C in
 * its own internal handler and calls `this.destroy()` on
 * `process.nextTick`, **unconditionally** — before the event even reaches
 * `App`'s `useKeyboard`, and regardless of what the latter would do with
 * it. With pending changes, a Ctrl+C (a terminal-exit reflex at least as
 * widespread as "q") would therefore lose them silently, without ever
 * going through the confirmation the brief requires. Disabling it here,
 * combined with the explicit interception of Ctrl+C in `App` (same path
 * as "q": `isDirty` then confirmation), is what makes that confirmation
 * genuinely inescapable — found in review of this task, see the
 * correction report.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
// Extensionless import, Bun/bundler style: unlike the rest of the
// monorepo (NodeNext, ".js" extension mandatory on relative imports),
// this package is never compiled by `tsc` — Bun resolves "./App" directly
// to "./App.tsx". See the task report for this deliberate divergence of
// convention.
import { App } from "./App";

export async function runTui(root: string): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(<App root={root} renderer={renderer} />);
}

if (import.meta.main) {
  await runTui(process.argv[2] ?? process.cwd());
}
