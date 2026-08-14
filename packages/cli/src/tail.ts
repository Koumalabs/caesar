/**
 * Following a growing file, by offset.
 *
 * Extracted from `commands/tasks.ts`, where it only served `caesar logs
 * --follow` on one task: `caesar watch` follows several at once, and
 * re-reading each `events.jsonl` in full on every frame would re-parse, for
 * a chatty task followed for ten minutes, thousands of lines five times a
 * second.
 *
 * No inotify or fswatch: a short poll is enough, stays portable, and keeps
 * no system resource open on files that another process is writing.
 */
import { readFile } from "node:fs/promises";

export interface FileTail {
  /** The bytes added since the last call. Empty string if nothing new. */
  read(): Promise<string>;
}

export interface LineTail {
  /**
   * The **complete** lines that appeared since the last call. A line still
   * being written is kept for the next call rather than returned truncated:
   * the engine writes `events.jsonl` line by line, but nothing guarantees a
   * reader does not land in the middle of a write.
   */
  read(): Promise<string[]>;
}

async function readTextSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // File not created yet (task starting up), or gone (task directory
    // collected): in both cases, nothing new to return.
    return "";
  }
}

export function createFileTail(path: string): FileTail {
  let offset = 0;
  return {
    async read() {
      const text = await readTextSafe(path);
      // A file shorter than on the last pass was replaced, not appended to:
      // start over from zero rather than returning garbage.
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
