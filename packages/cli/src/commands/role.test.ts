import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@caesar/core";
import { makeIo, withFakeHome, withShimmedPath, writeVersionOkShim, type CapturedIo } from "../../test/support.js";
import { runPolicyDeny } from "./policy.js";
import { runRoleAdd, runRoleList, runRoleRemove, runRoleShow } from "./role.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

describe("caesar role list", () => {
  let root: string;
  let shimDir: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-role-list-"));
    shimDir = await mkdtemp(join(tmpdir(), "caesar-cli-role-list-shim-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  });

  it("picks the first choice when it is installed and allowed", async () => {
    await withFakeHome(async () => {
      // The default "reviewer" role has the fallback order codex > antigravity:
      // both are shimmed "installed", so codex (first) must be picked.
      await writeVersionOkShim(shimDir, "codex", "codex 1.0.0");
      await writeVersionOkShim(shimDir, "agy", "agy 1.0.0");

      const code = await withShimmedPath(shimDir, () => runRoleList(root, { json: true }, io));
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      const reviewer = parsed.roles.find((r: { name: string }) => r.name === "reviewer");
      expect(reviewer.picked).toBe("codex");
    });
  });

  it("falls back to the second choice when the first is not installed", async () => {
    await withFakeHome(async () => {
      // Only antigravity is shimmed "installed": codex, absent from the
      // controlled PATH, must be set aside in favor of antigravity for
      // "reviewer".
      await writeVersionOkShim(shimDir, "agy", "agy 1.0.0");

      const code = await withShimmedPath(shimDir, () => runRoleList(root, { json: true }, io));
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      const reviewer = parsed.roles.find((r: { name: string }) => r.name === "reviewer");
      expect(reviewer.picked).toBe("antigravity");
    });
  });

  it("falls back to the second choice when the first is denied by the policy, even installed", async () => {
    await withFakeHome(async () => {
      await writeVersionOkShim(shimDir, "codex", "codex 1.0.0");
      await writeVersionOkShim(shimDir, "agy", "agy 1.0.0");
      await runPolicyDeny(root, "codex", {}, makeIo());

      const code = await withShimmedPath(shimDir, () => runRoleList(root, { json: true }, io));
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      const reviewer = parsed.roles.find((r: { name: string }) => r.name === "reviewer");
      expect(reviewer.picked).toBe("antigravity");
    });
  });

  it("human output: a table naming the role's pick of today", async () => {
    await withFakeHome(async () => {
      const code = await withShimmedPath(shimDir, () => runRoleList(root, {}, io));
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toContain("reviewer");
      expect(io.stdoutText()).toContain("picked today");
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });
});

describe("caesar role show / add / remove", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-role-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("show: details of a known role, system prompt included", async () => {
    await withFakeHome(async () => {
      const code = await runRoleShow(root, "reviewer", { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.name).toBe("reviewer");
      expect(parsed.systemPrompt).toBe("");
    });
  });

  it("show: unknown role, usage code", async () => {
    await withFakeHome(async () => {
      const code = await runRoleShow(root, "nonexistent", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/[Uu]nknown/);
    });
  });

  it("add: creates a role with the provided options, then remove deletes it", async () => {
    await withFakeHome(async () => {
      const code = await runRoleAdd(
        root,
        "custom",
        { purpose: "Test role.", agents: "codex,opencode", mode: "write", isolation: "worktree", timeout: "5m" },
        io,
      );
      expect(code).toBe(EXIT_OK);

      const { config } = await loadConfig(root);
      const custom = config.roles.find((r) => r.name === "custom");
      expect(custom).toMatchObject({
        name: "custom",
        purpose: "Test role.",
        agents: ["codex", "opencode"],
        mode: "write",
        isolation: "worktree",
        timeout_ms: 300_000,
      });

      const io2 = makeIo();
      expect(await runRoleRemove(root, "custom", {}, io2)).toBe(EXIT_OK);
      const reloaded = await loadConfig(root);
      expect(reloaded.config.roles.some((r) => r.name === "custom")).toBe(false);
    });
  });

  it("add: refuses an invalid --mode", async () => {
    await withFakeHome(async () => {
      const code = await runRoleAdd(root, "custom", { agents: "codex", mode: "readonly" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--mode/);
    });
  });

  it("add: refuses an empty --agents list", async () => {
    await withFakeHome(async () => {
      const code = await runRoleAdd(root, "custom", { mode: "write" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--agents/);
    });
  });

  it("remove: unknown role, usage code", async () => {
    await withFakeHome(async () => {
      const code = await runRoleRemove(root, "nonexistent", {}, io);
      expect(code).toBe(EXIT_USAGE);
    });
  });
});

describe("caesar role add / remove — scope (--global/--local)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-role-scope-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("add --global writes the global layer, never the project", async () => {
    await withFakeHome(async () => {
      expect(await runRoleAdd(root, "custom", { agents: "codex", mode: "write", global: true }, makeIo())).toBe(EXIT_OK);

      const { sources, layers } = await loadConfig(root);
      expect(sources.global).toBeDefined();
      expect(sources.project).toBeUndefined();
      const globalLayer = layers.find((l) => l.scope === "global")!;
      expect(globalLayer.override.roles?.map((r) => r.name)).toEqual(["custom"]);
    });
  });

  it("remove --local: removes a locally declared role, leaves the project and the global intact", async () => {
    await withFakeHome(async () => {
      expect(await runRoleAdd(root, "custom", { agents: "codex", mode: "write", local: true }, makeIo())).toBe(EXIT_OK);
      let loaded = await loadConfig(root);
      expect(loaded.config.roles.some((r) => r.name === "custom")).toBe(true);
      expect(loaded.sources.local).toBeDefined();

      expect(await runRoleRemove(root, "custom", { local: true }, makeIo())).toBe(EXIT_OK);
      loaded = await loadConfig(root);
      expect(loaded.config.roles.some((r) => r.name === "custom")).toBe(false);
    });
  });

  it("remove of a default role (declared by no layer): explicit error, points to the right answer rather than a misleading EXIT_OK", async () => {
    await withFakeHome(async () => {
      const io = makeIo();
      const code = await runRoleRemove(root, "reviewer", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/is not declared/);
      expect(io.stderrText()).toMatch(/default configuration/);

      // The default role has not moved: the command wrote nothing.
      const { config } = await loadConfig(root);
      expect(config.roles.some((r) => r.name === "reviewer")).toBe(true);
    });
  });

  it("remove of a role declared by ANOTHER layer than the targeted one: error naming the right layer", async () => {
    await withFakeHome(async () => {
      expect(await runRoleAdd(root, "custom", { agents: "codex", mode: "write", global: true }, makeIo())).toBe(EXIT_OK);

      const io = makeIo();
      // "custom" comes from the global: removing it on the project side (the default layer) must do nothing, and say so.
      const code = await runRoleRemove(root, "custom", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/is not declared/);
      expect(io.stderrText()).toMatch(/--global/);

      const { config } = await loadConfig(root);
      expect(config.roles.some((r) => r.name === "custom")).toBe(true);
    });
  });

  it("--global and --local together (add): explicit usage error, nothing is written", async () => {
    await withFakeHome(async () => {
      const io = makeIo();
      const code = await runRoleAdd(root, "custom", { agents: "codex", mode: "write", global: true, local: true }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/mutually exclusive/);

      const { sources } = await loadConfig(root);
      expect(sources).toEqual({});
    });
  });
});
