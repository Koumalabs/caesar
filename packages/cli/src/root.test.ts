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

  it("an explicit --root always wins", async () => {
    const explicit = join(base, "elsewhere");
    await mkdir(explicit, { recursive: true });
    expect(await resolveRoot(explicit, base)).toBe(explicit);
  });

  it("walks up to the first directory containing .caesar/", async () => {
    await mkdir(join(base, ".caesar"), { recursive: true });
    const nested = join(base, "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(await resolveRoot(undefined, nested)).toBe(base);
  });

  it("walks up to the first directory containing .git/", async () => {
    await mkdir(join(base, ".git"), { recursive: true });
    const nested = join(base, "packages", "cli");
    await mkdir(nested, { recursive: true });
    expect(await resolveRoot(undefined, nested)).toBe(base);
  });

  it("neither .caesar/ nor .git/ found: falls back to the starting directory", async () => {
    expect(await resolveRoot(undefined, base)).toBe(base);
  });

  it("the current directory itself containing .caesar/ is picked directly", async () => {
    await mkdir(join(base, ".caesar"), { recursive: true });
    expect(await resolveRoot(undefined, base)).toBe(base);
  });
});
