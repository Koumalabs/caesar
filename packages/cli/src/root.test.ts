import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRoot } from "./root.js";

describe("resolveRoot", () => {
  let base: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "caesar-cli-root-")));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("--root explicite l'emporte toujours", async () => {
    const explicit = join(base, "ailleurs");
    await mkdir(explicit, { recursive: true });
    expect(await resolveRoot(explicit, base)).toBe(explicit);
  });

  it("remonte jusqu'au premier répertoire contenant .caesar/", async () => {
    await mkdir(join(base, ".caesar"), { recursive: true });
    const nested = join(base, "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(await resolveRoot(undefined, nested)).toBe(base);
  });

  it("remonte jusqu'au premier répertoire contenant .git/", async () => {
    await mkdir(join(base, ".git"), { recursive: true });
    const nested = join(base, "packages", "cli");
    await mkdir(nested, { recursive: true });
    expect(await resolveRoot(undefined, nested)).toBe(base);
  });

  it("ni .caesar/ ni .git/ trouvé : replie sur le répertoire de départ", async () => {
    expect(await resolveRoot(undefined, base)).toBe(base);
  });

  it("le répertoire courant lui-même contenant .caesar/ est retenu directement", async () => {
    await mkdir(join(base, ".caesar"), { recursive: true });
    expect(await resolveRoot(undefined, base)).toBe(base);
  });
});
