/**
 * Reading and writing a role's system prompt — the only non-TOML file the
 * TUI touches, and the only one it writes **outside** the pending-changes
 * model.
 *
 * This exception is deliberate and must stay visible on screen (see
 * `PromptEditor`): `system_prompt_file` is a *path* in the configuration
 * — thus subject to the three layers and to "s" like everything else —,
 * but the content it names is a single Markdown file, shared by every
 * layer that names it. Putting it in the pending queue like a setting
 * would suggest it follows the editing scope, which is false: there is
 * only one of it.
 *
 * The path comes from `rolePromptPath` (`@caesar/core`), the function
 * `resolveRole` uses to *read* this same prompt when a task launches:
 * what is edited here is exactly what the agent will receive.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rolePromptPath } from "@caesar/core";

export interface PromptFile {
  /** Absolute path actually read by the engine — displayed as-is, without which one edits blindly. */
  path: string;
  content: string;
  /** False when the file does not exist yet: the editor says so rather than showing an ambiguous blank. */
  exists: boolean;
}

/** The conventional path for a role, the one `caesar init` already writes (`packages/cli/src/commands/init.ts`). */
export function defaultPromptFileFor(roleName: string): string {
  return `roles/${roleName}.md`;
}

/**
 * Refuses the paths `rolePromptPath` could not honor, naming the reason.
 * Both cases fail silently otherwise:
 *
 *  - an absolute path passed to `join(root, ".caesar", "/etc/x")` becomes
 *    `<root>/.caesar/etc/x` — one believes one is naming a system file,
 *    another gets created, and the prompt read is never the one written;
 *  - a `..` escapes the configuration directory, or even the project, and
 *    writes outside what the user believes they are modifying.
 */
export function validatePromptFile(file: string): string | null {
  const value = file.trim();
  if (value.length === 0) return "The prompt path cannot be empty.";
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) {
    return `Absolute path refused: "${value}". The prompt is looked up under "<project>/.caesar/"; give a relative path, for example "roles/${"<role>"}.md".`;
  }
  if (value.split(/[\\/]/).includes("..")) {
    return `Path refused: "${value}". A ".." would leave "<project>/.caesar/", where the engine goes looking for the prompt.`;
  }
  return null;
}

/** Reads a role's prompt. A missing file is not an error: it is the normal case of a role whose prompt remains to be written. */
export async function readPromptFile(root: string, systemPromptFile: string): Promise<PromptFile> {
  const path = rolePromptPath(root, systemPromptFile);
  try {
    return { path, content: await readFile(path, "utf8"), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, content: "", exists: false };
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Writes the prompt and returns the written path. Creation of the
 * intermediate directories included (a freshly created role does not have
 * a `roles/` yet), and atomic write — temporary file then `rename`, the
 * same pattern as `saveLayer`: an interruption mid-write would otherwise
 * leave a truncated prompt, which the engine would pass as-is to the
 * agent.
 */
export async function writePromptFile(root: string, systemPromptFile: string, content: string): Promise<string> {
  const path = rolePromptPath(root, systemPromptFile);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.prompt.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
  return path;
}
