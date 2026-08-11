/** Façade CLI de la décision de nettoyage portée par `@orch/core`. */
import { garbageCollectWorktrees } from "@orch/core";
import type { WorktreeGcEntry } from "@orch/core";
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
    diff_command: `orch diff ${entry.id}`,
    apply_command: `orch apply ${entry.id}`,
  };
}

function actionLabel(entry: WorktreeGcEntry): string {
  if (entry.action === "removed") return "supprimé";
  if (entry.action === "would_remove") return "serait supprimé";
  return "conservé";
}

function reasonLabel(entry: WorktreeGcEntry): string {
  switch (entry.reason) {
    case "clean":
      return entry.orphan ? "orphelin, aucune modification" : "tâche terminée, aucune modification";
    case "modified":
      return entry.action === "kept" ? "modifications non intégrées" : "modifications non intégrées, suppression forcée";
    case "active":
      return entry.status === "pending" ? "tâche en attente" : "tâche en cours";
    case "inspection_failed":
      return `inspection impossible${entry.error ? ` : ${entry.error}` : ""}`;
  }
}

/**
 * Ce qu'il faut faire d'un worktree conservé — une commande à recopier, ou le
 * chemin d'un orphelin à inspecter à la main.
 *
 * Sous le tableau, et non dans une cellule : ces deux textes sont longs par
 * nature, et une colonne les rognerait précisément là où ils doivent être
 * recopiables (`renderTable` plafonne à la largeur du terminal).
 */
function keptAdvice(entry: WorktreeGcEntry): string | null {
  if (entry.reason !== "modified" || entry.action !== "kept") return null;
  return entry.orphan
    ? `"${entry.id}" : orphelin porteur de modifications, inconnu du store — à inspecter à la main : ${entry.path}`
    : `"${entry.id}" : "orch diff ${entry.id}" pour voir ce qui n'a pas été intégré, "orch apply ${entry.id}" pour l'intégrer.`;
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
      entries: result.entries.map(jsonEntry),
    });
  } else if (result.entries.length === 0) {
    sectionHeader(io, "gc");
    writeLine(io.stdout, "Aucun worktree à nettoyer.");
  } else {
    sectionHeader(io, "gc");
    const rows: Cell[][] = result.entries.map((entry) => [
      entry.id,
      { text: entry.orphan ? "orphelin" : entry.status ?? "-", token: "dim" },
      // La décision est ce qu'on vient lire : supprimer se distingue de
      // conserver à la couleur, avant même que le mot ne soit lu.
      { text: actionLabel(entry), token: entry.action === "kept" ? "ok" : "warn" },
      { text: reasonLabel(entry), token: "dim" },
    ]);
    printTable(io, ["id", "origine/statut", "décision", "raison"], rows);
    const removedLabel = result.dryRun ? `${result.wouldRemove} suppression(s) prévue(s)` : `${result.removed} suppression(s)`;
    writeLine(io.stdout, `${removedLabel}, ${result.kept} conservation(s).`);

    const advices = result.entries.map(keptAdvice).filter((advice): advice is string => advice !== null);
    if (advices.length > 0) {
      writeLine(io.stdout);
      printHeading(io, "conservés");
      printNote(io, "Ceux-ci portent du travail non intégré.");
      for (const advice of advices) {
        for (const line of wrapText(advice, terminalWidth(io.stdout), "  - ", "    ")) writeLine(io.stdout, line);
      }
    }
  }

  return result.entries.some((entry) => entry.reason === "inspection_failed") ? EXIT_RUNTIME : EXIT_OK;
}
