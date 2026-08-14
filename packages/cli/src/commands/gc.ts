/** CLI facade over the cleanup decision carried by `@caesar/core`. */
import { garbageCollectWorktrees } from "@caesar/core";
import type { WorktreeGcEntry, WorktreeGcResult } from "@caesar/core";
import type { Cell, Io } from "../output.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  printHeading,
  printJson,
  printNote,
  printTable,
  sectionHeader,
  terminalWidth,
  wrapText,
  writeLine,
} from "../output.js";

export interface GcOptions {
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
}

function jsonEntry(entry: WorktreeGcEntry): WorktreeGcEntry & { diff_command?: string; apply_command?: string } {
  if (entry.reason !== "modified" || entry.action !== "kept" || entry.orphan) return entry;
  return {
    ...entry,
    diff_command: `caesar diff ${entry.id}`,
    apply_command: `caesar apply ${entry.id}`,
  };
}

function actionLabel(entry: WorktreeGcEntry): string {
  if (entry.action === "removed") return "removed";
  if (entry.action === "would_remove") return "would be removed";
  return "kept";
}

function reasonLabel(entry: WorktreeGcEntry): string {
  switch (entry.reason) {
    case "clean":
      return entry.orphan ? "orphan, no modifications" : "task finished, no modifications";
    case "applied":
      return "applied to the workspace, nothing new since";
    case "modified":
      if (entry.action !== "kept") return "non-integrated modifications, removal forced";
      return entry.applied_at ? "modified since it was applied" : "non-integrated modifications";
    case "active":
      return entry.status === "pending" ? "task pending" : "task in progress";
    case "inspection_failed":
      return `inspection impossible${entry.error ? `: ${entry.error}` : ""}`;
  }
}

/**
 * What to do with a kept worktree — a command to copy back, or the path of
 * an orphan to inspect by hand.
 *
 * Below the table, not in a cell: these two texts are long by nature, and a
 * column would trim them precisely where they must be copyable
 * (`renderTable` caps at the terminal width).
 */
function keptAdvice(entry: WorktreeGcEntry): string | null {
  if (entry.reason !== "modified" || entry.action !== "kept") return null;
  if (entry.orphan) {
    return `"${entry.id}": orphan carrying modifications, unknown to the store — inspect it by hand: ${entry.path}`;
  }
  if (entry.applied_at) {
    return `"${entry.id}": applied then modified — "caesar diff ${entry.id}" to see what changed since the apply, "caesar apply ${entry.id}" to re-apply.`;
  }
  return `"${entry.id}": "caesar diff ${entry.id}" to see what has not been integrated, "caesar apply ${entry.id}" to integrate it.`;
}

/**
 * The tasks concluded by decree, told before the worktrees: they are the
 * cause, the worktrees only the consequence. A task stuck "in progress"
 * held on to its worktree, and the user watched a `gc` with no effect
 * without ever knowing why.
 */
function printAbandoned(io: Io, result: WorktreeGcResult): void {
  if (result.abandoned.length === 0) return;
  printHeading(io, result.dryRun ? "tasks to conclude" : "tasks concluded");
  printNote(
    io,
    result.dryRun
      ? "The process driving them has disappeared; without --dry-run, they would be marked failed."
      : "The process driving them had disappeared without concluding them: marked failed.",
  );
  for (const task of result.abandoned) {
    writeLine(io.stdout, `  - ${task.id} (${task.status}, orchestrator pid ${task.pid} gone)`);
  }
  writeLine(io.stdout);
}

export async function runGc(root: string, options: GcOptions, io: Io): Promise<number> {
  const result = await garbageCollectWorktrees(root, { dryRun: options.dryRun, force: options.force });

  if (options.json) {
    printJson(io, {
      dry_run: result.dryRun,
      force: result.force,
      removed: result.removed,
      would_remove: result.wouldRemove,
      kept: result.kept,
      abandoned: result.abandoned,
      entries: result.entries.map(jsonEntry),
    });
  } else if (result.entries.length === 0) {
    sectionHeader(io, "gc");
    printAbandoned(io, result);
    writeLine(io.stdout, "No worktree to clean up.");
  } else {
    sectionHeader(io, "gc");
    printAbandoned(io, result);
    const rows: Cell[][] = result.entries.map((entry) => [
      entry.id,
      { text: entry.orphan ? "orphan" : entry.status ?? "-", token: "dim" },
      // The decision is what one comes to read: removing stands apart from
      // keeping by color, before the word is even read.
      { text: actionLabel(entry), token: entry.action === "kept" ? "ok" : "warn" },
      { text: reasonLabel(entry), token: "dim" },
    ]);
    printTable(io, ["id", "origin/status", "decision", "reason"], rows);
    const removedLabel = result.dryRun ? `${result.wouldRemove} planned removal(s)` : `${result.removed} removal(s)`;
    writeLine(io.stdout, `${removedLabel}, ${result.kept} kept.`);

    const advices = result.entries.map(keptAdvice).filter((advice): advice is string => advice !== null);
    if (advices.length > 0) {
      writeLine(io.stdout);
      printHeading(io, "kept");
      printNote(io, "These carry non-integrated work.");
      for (const advice of advices) {
        for (const line of wrapText(advice, terminalWidth(io.stdout), "  - ", "    ")) writeLine(io.stdout, line);
      }
    }
  }

  return result.entries.some((entry) => entry.reason === "inspection_failed") ? EXIT_RUNTIME : EXIT_OK;
}
