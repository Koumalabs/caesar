import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globalConfigPath, loadConfig, projectConfigPath } from "@caesar/core";
import { makeIo, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runInit } from "./init.js";
import { runPolicyAllow, runPolicyDeny, runPolicyShow } from "./policy.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

describe("caesar policy allow / deny", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-policy-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("allow then deny: the change is persisted in the TOML and re-read", async () => {
    await withFakeHome(async () => {
      expect(await runPolicyAllow(root, "codex", {}, io)).toBe(EXIT_OK);
      let loaded = await loadConfig(root);
      expect(loaded.config.policy.allowed).toContain("codex");

      const io2 = makeIo();
      expect(await runPolicyDeny(root, "copilot", {}, io2)).toBe(EXIT_OK);
      loaded = await loadConfig(root);
      expect(loaded.config.policy.denied).toContain("copilot");
      // The previous change (allow codex) survives the next one.
      expect(loaded.config.policy.allowed).toContain("codex");
    });
  });
});

describe("caesar policy show", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-policy-show-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("without any file: each field comes from the default", async () => {
    await withFakeHome(async () => {
      const code = await runPolicyShow(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(Object.values(parsed.provenance)).toEqual(Array(Object.keys(parsed.provenance).length).fill("default"));
      expect(parsed.sources).toEqual({});
    });
  });

  it("distinguishes global / project / default provenance, field by field", async () => {
    const home = await mkdtemp(join(tmpdir(), "caesar-cli-policy-home-"));
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), "[policy]\nmax_parallel = 9\nallow_recursion = true\n", "utf8");

      await mkdir(join(root, ".caesar"), { recursive: true });
      await writeFile(join(root, ".caesar", "config.toml"), "[policy]\nmax_parallel = 2\n", "utf8");

      const code = await runPolicyShow(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());

      // Set by the project (which wins over the global): provenance "project".
      expect(parsed.policy.max_parallel).toBe(2);
      expect(parsed.provenance.max_parallel).toBe("project");

      // Set by the global only: provenance "global".
      expect(parsed.policy.allow_recursion).toBe(true);
      expect(parsed.provenance.allow_recursion).toBe("global");

      // Never set: provenance "default".
      expect(parsed.provenance.default_mode).toBe("default");

      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    } finally {
      if (previous === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("human output: a field / value / provenance table", async () => {
    await withFakeHome(async () => {
      const code = await runPolicyShow(root, {}, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toContain("provenance");
      expect(io.stdoutText()).toContain("max_parallel");
      expect(io.stdoutText()).toContain("default");
    });
  });
});

/**
 * I11 (final branch review): a single "caesar policy deny" copied the
 * merged configuration (defaults + global + project) into the project file,
 * freezing all the global settings. This scenario goes through the CLI
 * facade (not through `materializePolicyList` directly — that facade was
 * the faulty one), with a neutralized `HOME`, exactly the verification
 * scenario of the task 13 brief.
 */
describe("I11 closed: the CLI facade no longer flattens the merged configuration into the project", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-i11-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('"policy deny --global" then "init" then "policy deny" (project): the project file carries only "denied"', async () => {
    await withFakeHome(async () => {
      expect(await runPolicyDeny(root, "copilot", { global: true }, makeIo())).toBe(EXIT_OK);
      expect(await runInit(root, {}, makeIo())).toBe(EXIT_OK);
      expect(await runPolicyDeny(root, "opencode", {}, makeIo())).toBe(EXIT_OK);

      // The *exact* content of the project file, not just the effective value re-read: it is the proof that the
      // defect is closed — only "denied", no default copied over (no max_parallel, no roles).
      const raw = await readFile(projectConfigPath(root), "utf8");
      expect(raw).toBe(
        "# File generated by @caesar/core: comments added by hand do not survive the next write.\n" +
          "\n" +
          "[policy]\n" +
          'denied = [ "copilot", "opencode" ]\n',
      );

      const { config } = await loadConfig(root);
      expect(config.policy.denied).toEqual(["copilot", "opencode"]);
    });
  });

  it("editing max_parallel in the global file afterwards is reflected in the project (caesar policy show)", async () => {
    await withFakeHome(async (home) => {
      expect(await runPolicyDeny(root, "copilot", { global: true }, makeIo())).toBe(EXIT_OK);
      expect(await runInit(root, {}, makeIo())).toBe(EXIT_OK);
      expect(await runPolicyDeny(root, "opencode", {}, makeIo())).toBe(EXIT_OK);

      // Edits the global file directly, by hand — exactly the brief's scenario: "by editing max_parallel in the
      // global file, caesar policy show in the project must reflect the new value".
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[policy]\ndenied = ["copilot"]\nmax_parallel = 11\n', "utf8");

      const io = makeIo();
      expect(await runPolicyShow(root, { json: true }, io)).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.policy.max_parallel).toBe(11);
      expect(parsed.provenance.max_parallel).toBe("global");
      // The materialization done earlier on "denied" still holds, independent of the global change.
      expect(parsed.policy.denied).toEqual(["copilot", "opencode"]);
    });
  });
});

describe("caesar policy allow / deny — scope (--global/--local)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-policy-scope-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--global writes the global layer, never the project", async () => {
    await withFakeHome(async (home) => {
      expect(await runPolicyDeny(root, "copilot", { global: true }, makeIo())).toBe(EXIT_OK);

      const raw = await readFile(globalConfigPath(), "utf8");
      expect(raw).toBe(
        "# File generated by @caesar/core: comments added by hand do not survive the next write.\n" +
          "\n" +
          "[policy]\n" +
          'denied = [ "copilot" ]\n',
      );

      const { sources } = await loadConfig(root);
      expect(sources.project).toBeUndefined();
      expect(sources.global).toBe(join(home, ".config", "caesar", "config.toml"));
    });
  });

  it("--local writes the local layer, never the project nor the global", async () => {
    await withFakeHome(async () => {
      expect(await runPolicyAllow(root, "codex", { local: true }, makeIo())).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".caesar", "config.local.toml"), "utf8");
      expect(raw).toBe(
        "# File generated by @caesar/core: comments added by hand do not survive the next write.\n" +
          "\n" +
          "[policy]\n" +
          'allowed = [ "codex" ]\n',
      );

      const { sources } = await loadConfig(root);
      expect(sources.project).toBeUndefined();
      expect(sources.local).toBe(join(root, ".caesar", "config.local.toml"));
    });
  });

  it("without an option: project layer, as before task 13", async () => {
    await withFakeHome(async () => {
      expect(await runPolicyDeny(root, "codex", {}, makeIo())).toBe(EXIT_OK);
      const { sources } = await loadConfig(root);
      expect(sources.project).toBe(projectConfigPath(root));
      expect(sources.global).toBeUndefined();
    });
  });

  it("--global and --local together: explicit usage error, nothing written to any layer", async () => {
    await withFakeHome(async () => {
      const io = makeIo();
      const code = await runPolicyDeny(root, "copilot", { global: true, local: true }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--global/);
      expect(io.stderrText()).toMatch(/--local/);
      expect(io.stderrText()).toMatch(/mutually exclusive/);

      const { sources } = await loadConfig(root);
      expect(sources).toEqual({});
    });
  });

  it("warns when the edited list was not declared by the targeted layer (materialization)", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[policy]\ndenied = ["copilot"]\n', "utf8");

      const io = makeIo();
      expect(await runPolicyDeny(root, "opencode", {}, io)).toBe(EXIT_OK);
      expect(io.stdoutText()).toMatch(/was not declared/);
      expect(io.stdoutText()).toContain("copilot, opencode");
    });
  });
});
