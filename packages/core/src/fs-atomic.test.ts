import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./fs-atomic.js";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "caesar-fs-atomic-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the content, re-readable as-is", async () => {
    const path = join(dir, "file.txt");
    await writeFileAtomic(path, "content\n");
    expect(await readFile(path, "utf8")).toBe("content\n");
  });

  it("replaces an existing file, without leaving residue", async () => {
    const path = join(dir, "file.txt");
    await writeFileAtomic(path, "first\n");
    await writeFileAtomic(path, "second\n");
    expect(await readFile(path, "utf8")).toBe("second\n");
    // Only the final target must remain in the directory — no abandoned temporary.
    expect(await readdir(dir)).toEqual(["file.txt"]);
  });

  it("creates the missing parent directory, recursively", async () => {
    const path = join(dir, "a", "b", "c", "file.txt");
    await writeFileAtomic(path, "deep\n");
    expect(await readFile(path, "utf8")).toBe("deep\n");
  });

  it("does not clobber an already-present parent (idempotent recursive mkdir)", async () => {
    await mkdir(join(dir, "existing"), { recursive: true });
    const path = join(dir, "existing", "file.txt");
    await writeFileAtomic(path, "ok\n");
    expect(await readFile(path, "utf8")).toBe("ok\n");
  });

  it("no temporary residue in the directory after a success", async () => {
    const path = join(dir, "subfolder", "file.txt");
    await writeFileAtomic(path, "content\n");
    expect(await readdir(join(dir, "subfolder"))).toEqual(["file.txt"]);
  });

  it("names the temporary `.<basename>.<uuid>.tmp` — hidden, non-.md", async () => {
    // `path` is itself an existing directory: `rename` fails with
    // EISDIR (verified on the development machine) and leaves the
    // temporary in place, observable without a race or a mock.
    const target = join(dir, "target-as-dir");
    await mkdir(target);

    await expect(writeFileAtomic(target, "content")).rejects.toThrow();

    const entries = await readdir(dir);
    const tmp = entries.find((entry) => entry !== "target-as-dir");
    expect(tmp).toBeDefined();
    expect(tmp).toMatch(/^\.target-as-dir\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/);
    expect(tmp).not.toMatch(/\.md$/);
  });
});
