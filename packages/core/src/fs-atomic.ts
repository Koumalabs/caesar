/**
 * Atomic writing of text files: the tmp+`rename` pattern repeated verbatim
 * in `store.ts`, `config.ts` (`saveLayer`) and `mcp-registration.ts`
 * (`writeJsonFileAtomic`) before this extraction — a single place to
 * define it since the next work stream (depositing skills/commands with
 * agent runtimes) will need it again.
 *
 * The temporary lives in the same directory as the target — a necessary
 * condition for `rename` to be atomic right after (same
 * filesystem) — and bears a hidden name (leading `.`) without an `.md`
 * extension: a recursive scan of the repository's Markdown files therefore
 * never picks it up between the write of the temporary and the `rename`.
 *
 * `store.ts` keeps its own pattern (shared `writeTemp`, then `rename` or
 * `link` depending on the operation): its conditional-replacement semantics
 * via `link` (see its header) fall outside the scope of this helper,
 * deliberately limited to the unconditional `rename` case.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Writes `content` to `path` atomically: a concurrent reader only ever
 * sees a complete version of the file (the old one or the
 * new one), never partial or truncated content if the process is
 * interrupted mid-write. Creates the parent directory if needed
 * (recursive `mkdir`), so the caller does not have to ensure it beforehand.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}
