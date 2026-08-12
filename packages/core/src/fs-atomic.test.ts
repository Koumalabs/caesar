import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./fs-atomic.js";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orch-fs-atomic-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("écrit le contenu, relisible tel quel", async () => {
    const path = join(dir, "fichier.txt");
    await writeFileAtomic(path, "contenu\n");
    expect(await readFile(path, "utf8")).toBe("contenu\n");
  });

  it("remplace un fichier existant, sans laisser de résidu", async () => {
    const path = join(dir, "fichier.txt");
    await writeFileAtomic(path, "premier\n");
    await writeFileAtomic(path, "second\n");
    expect(await readFile(path, "utf8")).toBe("second\n");
    // Seule la cible finale doit rester dans le répertoire — aucun temporaire abandonné.
    expect(await readdir(dir)).toEqual(["fichier.txt"]);
  });

  it("crée le répertoire parent manquant, récursivement", async () => {
    const path = join(dir, "a", "b", "c", "fichier.txt");
    await writeFileAtomic(path, "profond\n");
    expect(await readFile(path, "utf8")).toBe("profond\n");
  });

  it("n'écrase pas un parent déjà présent (mkdir récursif idempotent)", async () => {
    await mkdir(join(dir, "existant"), { recursive: true });
    const path = join(dir, "existant", "fichier.txt");
    await writeFileAtomic(path, "ok\n");
    expect(await readFile(path, "utf8")).toBe("ok\n");
  });

  it("aucun résidu temporaire dans le répertoire après un succès", async () => {
    const path = join(dir, "sous-dossier", "fichier.txt");
    await writeFileAtomic(path, "contenu\n");
    expect(await readdir(join(dir, "sous-dossier"))).toEqual(["fichier.txt"]);
  });

  it("nomme le temporaire `.<basename>.<uuid>.tmp` — caché, non-.md", async () => {
    // `path` est lui-même un répertoire existant : `rename` échoue avec
    // EISDIR (vérifié sur la machine de développement) et laisse le
    // temporaire en place, observable sans course ni mock.
    const target = join(dir, "cible-en-dossier");
    await mkdir(target);

    await expect(writeFileAtomic(target, "contenu")).rejects.toThrow();

    const entries = await readdir(dir);
    const tmp = entries.find((entry) => entry !== "cible-en-dossier");
    expect(tmp).toBeDefined();
    expect(tmp).toMatch(/^\.cible-en-dossier\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/);
    expect(tmp).not.toMatch(/\.md$/);
  });
});
