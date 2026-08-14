/**
 * Moved from `packages/cli/src/commands/mcp.test.ts` (task 8, correction
 * report): this logic now lives in `@caesar/core`, so it is
 * tested here — like any other module of the package (see `policy.ts`,
 * `roles.ts`, `config.ts`). `packages/cli/src/commands/mcp.test.ts` keeps
 * verifying the dressing (`Io`, `--json`, exit codes) on top, without
 * rewriting: its tests still pass, unchanged.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homeDirectory } from "./config.js";
import { applyPlan, buildPlan, checkMcpStatus, isMcpClient, MCP_CLIENTS } from "./mcp-registration.js";

/** Same pattern as `config.test.ts`: `buildPlan`/`checkMcpStatus` read `$HOME` (via `node:os#homedir`) for the file-based clients. */
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "caesar-mcp-home-"));
  const previous = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

describe("MCP_CLIENTS / isMcpClient", () => {
  it("lists the five clients in a stable order", () => {
    expect(MCP_CLIENTS).toEqual(["claude", "codex", "copilot", "opencode", "antigravity"]);
  });

  it("isMcpClient recognizes a known client, rejects the rest", () => {
    expect(isMcpClient("claude")).toBe(true);
    expect(isMcpClient("bogus")).toBe(false);
  });
});

describe("buildPlan", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("claude and codex: \"command\" plan, native subcommand", async () => {
    await withFakeHome(async () => {
      const claude = buildPlan("claude", root);
      expect(claude).toEqual({ client: "claude", kind: "command", bin: "claude", args: ["mcp", "add", "caesar", "--", "caesar", "mcp", "serve", "--root", root] });

      const codex = buildPlan("codex", root);
      expect(codex.kind).toBe("command");
      expect(codex.kind === "command" && codex.bin).toBe("codex");
    });
  });

  it("copilot, antigravity, opencode: \"file\" plan, under $HOME", async () => {
    await withFakeHome(async (home) => {
      const copilot = buildPlan("copilot", root);
      expect(copilot).toEqual({
        client: "copilot",
        kind: "file",
        path: join(home, ".copilot", "mcp-config.json"),
        mergeKey: "mcpServers",
        entry: { type: "stdio", command: "caesar", args: ["mcp", "serve", "--root", root] },
      });

      const antigravity = buildPlan("antigravity", root);
      expect(antigravity.kind).toBe("file");
      expect(antigravity.kind === "file" && antigravity.path).toBe(join(home, ".gemini", "antigravity-cli", "settings.json"));

      const opencode = buildPlan("opencode", root);
      expect(opencode.kind).toBe("file");
      expect(opencode.kind === "file" && opencode.mergeKey).toBe("mcp");
    });
  });

  it("the three \"file\" paths follow homeDirectory() (@caesar/core), never bare os.homedir() (task 15 review)", async () => {
    // Passes trivially under Node (vitest, this file): os.homedir() already respects $HOME there. The value of this
    // test is to pin the implementation for Bun (packages/tui, which consumes this compiled module and neutralizes
    // $HOME in IntegrationsScreen.render.test.tsx): a direct homedir() would regress silently under
    // Bun only, without any Node test detecting it — exactly the defect the review flagged
    // (buildPlan still read bare os.homedir() for copilot/antigravity/opencode after the first
    // fix, which had only routed globalConfigPath()).
    await withFakeHome(async () => {
      const expectedHome = homeDirectory();
      const copilot = buildPlan("copilot", root);
      expect(copilot.kind === "file" && copilot.path).toBe(join(expectedHome, ".copilot", "mcp-config.json"));

      const antigravity = buildPlan("antigravity", root);
      expect(antigravity.kind === "file" && antigravity.path).toBe(join(expectedHome, ".gemini", "antigravity-cli", "settings.json"));

      const opencode = buildPlan("opencode", root);
      expect(opencode.kind === "file" && opencode.path).toBe(join(expectedHome, ".config", "opencode", "opencode.json"));
    });
  });
});

describe("applyPlan", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("\"file\" plan: merges into an existing file, without losing the other entries", async () => {
    await withFakeHome(async (home) => {
      const path = join(home, ".copilot", "mcp-config.json");
      await mkdir(join(home, ".copilot"), { recursive: true });
      await writeFile(path, JSON.stringify({ mcpServers: { other: { command: "other-cli" } } }), "utf8");

      await applyPlan(buildPlan("copilot", root));

      const written = JSON.parse(await readFile(path, "utf8"));
      expect(written.mcpServers.other).toEqual({ command: "other-cli" });
      expect(written.mcpServers.caesar).toEqual({ type: "stdio", command: "caesar", args: ["mcp", "serve", "--root", root] });
    });
  });

  it("\"file\" plan: creates the file (and its directory) if it does not exist", async () => {
    await withFakeHome(async (home) => {
      await applyPlan(buildPlan("copilot", root));
      const written = JSON.parse(await readFile(join(home, ".copilot", "mcp-config.json"), "utf8"));
      expect(written.mcpServers.caesar.command).toBe("caesar");
    });
  });

  it("\"command\" plan: actually executes the binary (here a fake \"claude\" under a controlled PATH)", async () => {
    await withFakeHome(async () => {
      const shimDir = await mkdtemp(join(tmpdir(), "caesar-mcp-shim-"));
      const captureFile = join(shimDir, "capture.json");
      const script = `#!/usr/bin/env node\nconst fs = require("fs");\nfs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(2)));\n`;
      const target = join(shimDir, "claude");
      await writeFile(target, script, "utf8");
      await chmod(target, 0o755);

      const previousPath = process.env["PATH"];
      // Like `packages/cli/test/support.ts` (`withShimmedPath`): the fake
      // scripts have `/usr/bin/env node` as shebang, so the directory of the
      // current node binary is needed too, not just the shim.
      process.env["PATH"] = [shimDir, "/usr/bin", "/bin", dirname(process.execPath)].join(delimiter);
      try {
        await applyPlan(buildPlan("claude", root));
        const captured = JSON.parse(await readFile(captureFile, "utf8"));
        expect(captured).toEqual(["mcp", "add", "caesar", "--", "caesar", "mcp", "serve", "--root", root]);
      } finally {
        if (previousPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = previousPath;
        await rm(shimDir, { recursive: true, force: true });
      }
    });
  });
});

describe("checkMcpStatus", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("\"not-registered\" when the file does not exist yet", async () => {
    await withFakeHome(async () => {
      const status = await checkMcpStatus("copilot", root);
      expect(status).toEqual({ client: "copilot", registered: "not-registered", detail: expect.stringContaining("Absent from") });
    });
  });

  it("\"registered\" once the entry is present, without going through applyPlan", async () => {
    await withFakeHome(async (home) => {
      const path = join(home, ".copilot", "mcp-config.json");
      await mkdir(join(home, ".copilot"), { recursive: true });
      await writeFile(path, JSON.stringify({ mcpServers: { caesar: { command: "caesar" } } }), "utf8");

      const status = await checkMcpStatus("copilot", root);
      expect(status.registered).toBe("registered");
    });
  });

  it("claude and codex: \"unknown\", without launching a single subprocess", async () => {
    await withFakeHome(async () => {
      const claude = await checkMcpStatus("claude", root);
      expect(claude.registered).toBe("unknown");
      expect(claude.detail).toContain("claude mcp list");

      const codex = await checkMcpStatus("codex", root);
      expect(codex.registered).toBe("unknown");
      expect(codex.detail).toContain("codex mcp list");
    });
  });
});
