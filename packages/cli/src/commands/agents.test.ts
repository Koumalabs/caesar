import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadLayer, saveLayer } from "@caesar/core";
import { makeIo, withFakeAgentAsBin, withFakeHome, type CapturedIo } from "../../test/support.js";
import {
  runAgentsAdd,
  runAgentsDisable,
  runAgentsEnable,
  runAgentsList,
  runAgentsRemove,
  runAgentsSetModel,
  runAgentsTest,
  runAgentsUnsetModel,
} from "./agents.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

const execFileAsync = promisify(execFile);

describe("caesar agents list", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-agents-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--json lists the catalog with presence, capabilities and policy, without ANSI", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsList(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.agents.map((a: { id: string }) => a.id)).toEqual(["codex", "antigravity", "opencode", "copilot", "claude"]);
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });
});

describe("caesar agents enable / disable", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-agents-toggle-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("disable then enable: the change is persisted in the TOML and re-read", async () => {
    await withFakeHome(async () => {
      expect(await runAgentsDisable(root, "codex", {}, io)).toBe(EXIT_OK);
      let loaded = await loadConfig(root);
      expect(loaded.config.policy.denied).toContain("codex");

      const io2 = makeIo();
      expect(await runAgentsEnable(root, "codex", {}, io2)).toBe(EXIT_OK);
      loaded = await loadConfig(root);
      expect(loaded.config.policy.denied).not.toContain("codex");
    });
  });

  it("--json reports the final state of the denied list", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsDisable(root, "opencode", { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.denied).toContain("opencode");
    });
  });
});

describe("caesar agents add / remove", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-agents-declare-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("declares an agent, which immediately joins the effective catalog", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsAdd(root, "aider", { bin: "aider", args: "--message {{prompt}} --yes" }, io);
      expect(code).toBe(EXIT_OK);

      const { config } = await loadConfig(root);
      expect(config.agents).toEqual([
        { id: "aider", bin: "aider", args: ["--message", "{{prompt}}", "--yes"], cwdMode: "process" },
      ]);

      // What really matters: `caesar agents list` sees it, so `caesar run
      // --agent aider` can resolve it.
      const listIo = makeIo();
      await runAgentsList(root, { json: true }, listIo);
      expect(JSON.parse(listIo.stdoutText()).agents.map((a: { id: string }) => a.id)).toContain("aider");
    });
  });

  it("splits the template while honoring quotes", async () => {
    await withFakeHome(async () => {
      expect(await runAgentsAdd(root, "my-cli", { bin: "my-cli", args: '--system "you are {{prompt}}"' }, io)).toBe(EXIT_OK);
      const { config } = await loadConfig(root);
      expect(config.agents[0]!.args).toEqual(["--system", "you are {{prompt}}"]);
    });
  });

  it("refuses a template without {{prompt}}: the agent would never receive the objective", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsAdd(root, "mute", { bin: "mute", args: "exec --json" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/task's objective/);
      expect((await loadConfig(root)).config.agents).toEqual([]);
    });
  });

  it("refuses a misspelled token while naming it", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsAdd(root, "typo", { bin: "x", args: "--message {{promt}}" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/\{\{promt\}\}/);
    });
  });

  it("refuses an unclosed quote rather than recording a truncated command line", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsAdd(root, "x", { bin: "x", args: '--system "you are {{prompt}}' }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/[Uu]nclosed/);
    });
  });

  it("flags that the binary is missing from the PATH, without refusing the declaration", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsAdd(root, "absent", { bin: "binary-that-does-not-exist-caesar", args: "{{prompt}}" }, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toMatch(/not found in the PATH/);
      expect((await loadConfig(root)).config.agents).toHaveLength(1);
    });
  });

  it("an explicit path is checked as-is, and the message does not send people to the PATH", async () => {
    await withFakeHome(async () => {
      // Absolute path to a real executable: no warning.
      expect(await runAgentsAdd(root, "real", { bin: process.execPath, args: "{{prompt}}" }, io)).toBe(EXIT_OK);
      expect(io.stdoutText()).not.toMatch(/not found|does not exist/);

      // Absolute path to nothing: warning, but phrased about the file.
      const io2 = makeIo();
      expect(await runAgentsAdd(root, "ghost", { bin: "/opt/nothing/at/all", args: "{{prompt}}" }, io2)).toBe(EXIT_OK);
      expect(io2.stdoutText()).toMatch(/does not exist or is not executable/);
      expect(io2.stdoutText()).not.toMatch(/PATH/);
    });
  });

  it("warns that a declaration carrying a native identifier replaces the adapter", async () => {
    await withFakeHome(async () => {
      expect(await runAgentsAdd(root, "codex", { bin: "codex", args: "{{prompt}}" }, io)).toBe(EXIT_OK);
      expect(io.stdoutText()).toMatch(/native catalog/);
    });
  });

  it("--read-only-native survives the round trip, and is false without the option", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "ro", { bin: "ro", args: "{{prompt}}", readOnlyNative: true }, io);
      await runAgentsAdd(root, "rw", { bin: "rw", args: "{{prompt}}" }, makeIo());
      const { config } = await loadConfig(root);
      expect(config.agents.find((a) => a.id === "ro")?.capabilities).toEqual({ nativeReadOnly: true });
      expect(config.agents.find((a) => a.id === "rw")).not.toHaveProperty("capabilities");
    });
  });

  it("writes the targeted layer, and it alone", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "global-only", { bin: "x", args: "{{prompt}}", global: true }, io);
      const { layers } = await loadConfig(root);
      expect(layers.find((l) => l.scope === "global")?.override.agents?.[0]?.id).toBe("global-only");
      expect(layers.find((l) => l.scope === "project")?.override.agents).toBeUndefined();
    });
  });

  it("replaces an existing declaration of the same layer rather than doubling it", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "a", { bin: "v1", args: "{{prompt}}" }, io);
      await runAgentsAdd(root, "a", { bin: "v2", args: "{{prompt}}" }, makeIo());
      const { config } = await loadConfig(root);
      expect(config.agents).toHaveLength(1);
      expect(config.agents[0]!.bin).toBe("v2");
    });
  });

  it("remove removes the declaration from the layer carrying it", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "a", { bin: "x", args: "{{prompt}}" }, io);
      const removeIo = makeIo();
      expect(await runAgentsRemove(root, "a", {}, removeIo)).toBe(EXIT_OK);
      expect((await loadConfig(root)).config.agents).toEqual([]);
    });
  });

  it("remove on another layer refuses and names the declaring one", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "a", { bin: "x", args: "{{prompt}}", global: true }, io);
      const removeIo = makeIo();
      // Keyed merging cannot express a deletion: removing "a" from the
      // project layer would not make it disappear from the merge.
      expect(await runAgentsRemove(root, "a", {}, removeIo)).toBe(EXIT_USAGE);
      expect(removeIo.stderrText()).toMatch(/--global/);
      expect((await loadConfig(root)).config.agents).toHaveLength(1);
    });
  });

  it("remove on a native agent points to \"agents disable\" rather than pretending", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsRemove(root, "codex", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/agents disable codex/);
    });
  });
});

describe("caesar agents set-model / unset-model", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-agents-model-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the targeted layer (project by default), keeping the rest of what it declared", async () => {
    await withFakeHome(async () => {
      await saveLayer("project", root, { policy: { max_parallel: 7 } });
      expect(await runAgentsSetModel(root, "codex", "gpt-5.2", {}, io)).toBe(EXIT_OK);

      const layer = await loadLayer("project", root);
      expect(layer.models).toEqual({ codex: "gpt-5.2" });
      expect(layer.policy?.max_parallel).toBe(7);
      expect((await loadConfig(root)).config.models["codex"]).toBe("gpt-5.2");
    });
  });

  it("--global writes the global layer, and it alone", async () => {
    await withFakeHome(async () => {
      expect(await runAgentsSetModel(root, "codex", "gpt-5.2", { global: true }, io)).toBe(EXIT_OK);
      expect((await loadLayer("global", root)).models).toEqual({ codex: "gpt-5.2" });
      expect((await loadLayer("project", root)).models).toBeUndefined();
    });
  });

  it("refuses an agent unknown to the catalog, naming it", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsSetModel(root, "ghost", "m", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toContain("ghost");
    });
  });

  it("recognizes a generic agent declared in another layer than the targeted one", async () => {
    await withFakeHome(async () => {
      // Declared in the global layer, model written to the project layer:
      // existence is judged on the merged catalog, not on the target.
      await saveLayer("global", root, { agents: [{ id: "aider", bin: "aider", args: ["{{model}}", "{{prompt}}"] }] });
      expect(await runAgentsSetModel(root, "aider", "m", {}, io)).toBe(EXIT_OK);
      expect((await loadLayer("project", root)).models).toEqual({ aider: "m" });
    });
  });

  it("an agent without the model capability: records the default anyway, but says it", async () => {
    await withFakeHome(async () => {
      await runAgentsAdd(root, "aider", { bin: "aider", args: "--message {{prompt}}" }, makeIo());

      const code = await runAgentsSetModel(root, "aider", "m", { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.capability_missing).toBe(true);
      expect((await loadLayer("project", root)).models).toEqual({ aider: "m" });

      const humanIo = makeIo();
      expect(await runAgentsSetModel(root, "aider", "m2", {}, humanIo)).toBe(EXIT_OK);
      expect(humanIo.stdoutText()).toMatch(/does not support choosing a model/);
    });
  });

  it("unset-model removes the key and keeps the others; an emptied table disappears from the layer", async () => {
    await withFakeHome(async () => {
      await runAgentsSetModel(root, "codex", "a", {}, makeIo());
      await runAgentsSetModel(root, "claude", "b", {}, makeIo());

      expect(await runAgentsUnsetModel(root, "codex", {}, io)).toBe(EXIT_OK);
      expect((await loadLayer("project", root)).models).toEqual({ claude: "b" });

      expect(await runAgentsUnsetModel(root, "claude", {}, makeIo())).toBe(EXIT_OK);
      // An empty record would merely be dead weight in a key-by-key merge —
      // unlike policy lists, it can mask nothing: the key goes entirely.
      expect((await loadLayer("project", root)).models).toBeUndefined();
    });
  });

  it("unset-model on a layer that does not declare the key names the declaring layer", async () => {
    await withFakeHome(async () => {
      await runAgentsSetModel(root, "codex", "a", { global: true }, makeIo());

      const code = await runAgentsUnsetModel(root, "codex", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toContain("--global");
    });
  });

  it("unset-model when no layer declares the key says there is nothing to remove", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsUnsetModel(root, "codex", {}, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/no layer/i);
    });
  });

  it("agents list publishes the effective default model and its provenance", async () => {
    await withFakeHome(async () => {
      await runAgentsSetModel(root, "codex", "gpt-5.2", {}, makeIo());

      const code = await runAgentsList(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      const codex = parsed.agents.find((a: { id: string }) => a.id === "codex");
      expect(codex.default_model).toBe("gpt-5.2");
      expect(codex.model_provenance).toBe("project");
      const claude = parsed.agents.find((a: { id: string }) => a.id === "claude");
      expect(claude.default_model).toBeUndefined();
    });
  });
});

describe("caesar agents test", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-agents-test-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses an unknown agent identifier, without launching anything", async () => {
    const code = await runAgentsTest(root, "ghost-agent", { yes: true }, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/[Uu]nknown/);
  });

  it("requires --yes: refuses to launch a real task without explicit confirmation", async () => {
    const code = await runAgentsTest(root, "codex", {}, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/--yes/);
  });

  it("honors the policy: a denied agent is never launched, even with --yes", async () => {
    await withFakeHome(async () => {
      await runAgentsDisable(root, "codex", {}, makeIo());
      const code = await runAgentsTest(root, "codex", { yes: true }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toContain("codex");
      expect(io.stderrText()).toMatch(/denied/);
    });
  });

  it("--yes: full round trip with a fake agent substituted for the real binary", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        // "git init": `agents test` goes through `runTask`, whose explicit
        // "inplace" isolation does not need a git repository, but a real
        // repository removes any ambiguity about the observed behavior.
        await execFileAsync("git", ["init", "-q"], { cwd: root });
        await execFileAsync("git", ["config", "user.email", "caesar-test@example.com"], { cwd: root });
        await execFileAsync("git", ["config", "user.name", "Caesar Test"], { cwd: root });

        const code = await runAgentsTest(root, "codex", { yes: true, json: true }, io);
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.responded).toBe(true);
        expect(parsed.report_source).toBe("file");
        expect(code).toBe(EXIT_OK);
      }),
    );
  }, 20_000);
});
