import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeIo, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runMcpInstall, runMcpServe } from "./mcp.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

describe("orch mcp install --dry-run", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-mcp-install-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("claude : le plan exécuterait \"claude mcp add\", sans rien lancer", async () => {
    await withFakeHome(async () => {
      const code = await runMcpInstall(root, "claude", { dryRun: true, json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.dry_run).toBe(true);
      expect(parsed.action).toBe("run-command");
      expect(parsed.command[0]).toBe("claude");
      expect(parsed.command).toContain("orch");
      expect(parsed.command).toEqual(expect.arrayContaining(["mcp", "add", "orch", "--", "orch", "mcp", "serve", "--root", root]));
    });
  });

  it("codex : le plan exécuterait \"codex mcp add\", sans rien lancer", async () => {
    await withFakeHome(async () => {
      const code = await runMcpInstall(root, "codex", { dryRun: true, json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.action).toBe("run-command");
      expect(parsed.command[0]).toBe("codex");
    });
  });

  it("copilot : le plan écrirait ~/.copilot/mcp-config.json, sans rien écrire", async () => {
    await withFakeHome(async (home) => {
      const code = await runMcpInstall(root, "copilot", { dryRun: true, json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.action).toBe("write-file");
      expect(parsed.file).toBe(join(home, ".copilot", "mcp-config.json"));
      expect(parsed.key).toBe("mcpServers");
      expect(parsed.entry).toEqual({ type: "stdio", command: "orch", args: ["mcp", "serve", "--root", root] });

      await expect(readFile(parsed.file, "utf8")).rejects.toThrow();
    });
  });

  it("antigravity : le plan écrirait ~/.gemini/antigravity-cli/settings.json, sans rien écrire", async () => {
    await withFakeHome(async (home) => {
      const code = await runMcpInstall(root, "antigravity", { dryRun: true, json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.action).toBe("write-file");
      expect(parsed.file).toBe(join(home, ".gemini", "antigravity-cli", "settings.json"));

      await expect(readFile(parsed.file, "utf8")).rejects.toThrow();
    });
  });

  it("opencode : le plan écrirait ~/.config/opencode/opencode.json (repli fichier — voir le rapport de la tâche 7)", async () => {
    await withFakeHome(async (home) => {
      const code = await runMcpInstall(root, "opencode", { dryRun: true, json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.action).toBe("write-file");
      expect(parsed.file).toBe(join(home, ".config", "opencode", "opencode.json"));
      expect(parsed.key).toBe("mcp");
      expect(parsed.entry).toEqual({ type: "local", command: ["orch", "mcp", "serve", "--root", root], enabled: true });
    });
  });

  it("client inconnu : code d'usage, rien exécuté", async () => {
    await withFakeHome(async () => {
      const code = await runMcpInstall(root, "bogus", { dryRun: true }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/inconnu/);
    });
  });

  it("--dry-run n'écrit rien sur stdout hors le plan (pas de couleur, JSON pur)", async () => {
    await withFakeHome(async () => {
      const code = await runMcpInstall(root, "copilot", { dryRun: true, json: true }, io);
      expect(code).toBe(EXIT_OK);
      expect(() => JSON.parse(io.stdoutText())).not.toThrow();
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
      expect(io.stderrText()).toBe("");
    });
  });
});

describe("orch mcp install (écriture réelle, sous HOME factice)", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-mcp-install-real-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("copilot : fusionne dans mcp-config.json existant, sans perdre les autres serveurs", async () => {
    await withFakeHome(async (home) => {
      const path = join(home, ".copilot", "mcp-config.json");
      await mkdir(join(home, ".copilot"), { recursive: true });
      await writeFile(path, JSON.stringify({ mcpServers: { autre: { type: "stdio", command: "autre-cli" } } }), "utf8");

      const code = await runMcpInstall(root, "copilot", {}, io);
      expect(code).toBe(EXIT_OK);

      const written = JSON.parse(await readFile(path, "utf8"));
      expect(written.mcpServers.autre).toEqual({ type: "stdio", command: "autre-cli" });
      expect(written.mcpServers.orch).toEqual({ type: "stdio", command: "orch", args: ["mcp", "serve", "--root", root] });
    });
  });

  it("antigravity : préserve trustedWorkspaces et le reste du fichier existant", async () => {
    await withFakeHome(async (home) => {
      const dir = join(home, ".gemini", "antigravity-cli");
      const path = join(dir, "settings.json");
      await mkdir(dir, { recursive: true });
      const existing = {
        trustedWorkspaces: ["/Users/quelquun/projet-a", "/Users/quelquun/projet-b"],
        theme: "dark",
      };
      await writeFile(path, JSON.stringify(existing), "utf8");

      const code = await runMcpInstall(root, "antigravity", {}, io);
      expect(code).toBe(EXIT_OK);

      const written = JSON.parse(await readFile(path, "utf8"));
      expect(written.trustedWorkspaces).toEqual(existing.trustedWorkspaces);
      expect(written.theme).toBe("dark");
      expect(written.mcpServers.orch).toEqual({ command: "orch", args: ["mcp", "serve", "--root", root] });
    });
  });

  it("copilot : crée le fichier s'il n'existe pas encore", async () => {
    await withFakeHome(async (home) => {
      const code = await runMcpInstall(root, "copilot", {}, io);
      expect(code).toBe(EXIT_OK);
      const path = join(home, ".copilot", "mcp-config.json");
      const written = JSON.parse(await readFile(path, "utf8"));
      expect(written.mcpServers.orch.command).toBe("orch");
    });
  });
});

describe("orch mcp serve", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-mcp-serve-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("le diagnostic va sur stderr, rien sur stdout, et le protocole transite sur le flux dédié", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let stdoutBytes = "";
    stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.toString("utf8");
    });

    const code = await runMcpServe(root, io, { stdin, stdout });
    expect(code).toBe(EXIT_OK);

    // Le message d'accueil est un diagnostic : stderr, jamais l'`io.stdout` de la commande.
    expect(io.stderrText()).toMatch(/Serveur MCP/);
    expect(io.stdoutText()).toBe("");

    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    };
    stdin.write(JSON.stringify(initRequest) + "\n");
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 100));

    // Le flux stdio dédié au protocole, lui, ne porte que du JSON-RPC — pas
    // de mélange avec `io.stdout` (qui reste vide) ni avec un quelconque log.
    expect(stdoutBytes.length).toBeGreaterThan(0);
    for (const line of stdoutBytes.split("\n").filter((l) => l.trim() !== "")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    stdin.end();
  });
});
