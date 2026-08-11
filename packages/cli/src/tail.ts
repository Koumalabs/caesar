/**
 * Suivi d'un fichier qui grossit, par décalage.
 *
 * Extrait de `commands/tasks.ts`, où il ne servait qu'à `orch logs --follow`
 * sur une tâche : `orch watch` en suit plusieurs à la fois, et relire chaque
 * `events.jsonl` en entier à chaque image reparserait, pour une tâche bavarde
 * suivie dix minutes, des milliers de lignes cinq fois par seconde.
 *
 * Pas d'inotify ni de fswatch : une scrutation courte suffit, reste portable,
 * et ne fait tenir aucune ressource système ouverte sur des fichiers qu'un
 * autre processus écrit.
 */
import { readFile } from "node:fs/promises";

export interface FileTail {
  /** Les octets ajoutés depuis le dernier appel. Chaîne vide si rien de neuf. */
  read(): Promise<string>;
}

export interface LineTail {
  /**
   * Les lignes **complètes** apparues depuis le dernier appel. Une ligne en
   * cours d'écriture est conservée pour le prochain appel plutôt que rendue
   * tronquée : le moteur écrit `events.jsonl` ligne à ligne, mais rien ne
   * garantit qu'un lecteur ne tombe pas au milieu d'une écriture.
   */
  read(): Promise<string[]>;
}

async function readTextSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // Fichier pas encore créé (tâche qui démarre), ou disparu (répertoire de
    // tâche collecté) : dans les deux cas, rien de neuf à rendre.
    return "";
  }
}

export function createFileTail(path: string): FileTail {
  let offset = 0;
  return {
    async read() {
      const text = await readTextSafe(path);
      // Un fichier plus court qu'au dernier passage a été remplacé, pas
      // complété : on repart de zéro plutôt que de rendre n'importe quoi.
      if (text.length < offset) offset = 0;
      if (text.length === offset) return "";
      const chunk = text.slice(offset);
      offset = text.length;
      return chunk;
    },
  };
}

export function createLineTail(path: string): LineTail {
  const tail = createFileTail(path);
  let buffer = "";
  return {
    async read() {
      buffer += await tail.read();
      if (buffer === "") return [];
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines.filter((line) => line.trim() !== "");
    },
  };
}
