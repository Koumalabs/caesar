/**
 * Déplacé depuis `packages/cli/src/commands/mcp.test.ts` (tâche 8, rapport
 * de correction) : cette logique vit maintenant dans `@orch/core`, elle est
 * donc testée ici — comme tout autre module du package (voir `policy.ts`,
 * `roles.ts`, `config.ts`). `packages/cli/src/commands/mcp.test.ts` continue
 * de vérifier l'habillage (`Io`, `--json`, codes de sortie) au-dessus, sans
 * réécriture : ses tests passent toujours, inchangés.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan, buildPlan, checkMcpStatus, isMcpClient, MCP_CLIENTS } from "./mcp-registration.js";

/** Même motif que `config.test.ts` : `buildPlan`/`checkMcpStatus` lisent `$HOME` (via `node:os#homedir`) pour les clients à fichier. */
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "orch-mcp-home-"));
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
  it("liste les cinq clients dans un ordre stable", () => {
    expect(MCP_CLIENTS).toEqual(["claude", "codex", "copilot", "opencode", "antigravity"]);
  });

  it("isMcpClient reconnaît un client connu, rejette le reste", () => {
    expect(isMcpClient("claude")).toBe(true);
    expect(isMcpClient("bogus")).toBe(false);
  });
});

describe("buildPlan", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("claude et codex : plan \"command\", sous-commande native", async () => {
    await withFakeHome(async () => {
      const claude = buildPlan("claude", root);
      expect(claude).toEqual({ client: "claude", kind: "command", bin: "claude", args: ["mcp", "add", "orch", "--", "orch", "mcp", "serve", "--root", root] });

      const codex = buildPlan("codex", root);
      expect(codex.kind).toBe("command");
      expect(codex.kind === "command" && codex.bin).toBe("codex");
    });
  });

  it("copilot, antigravity, opencode : plan \"file\", sous $HOME", async () => {
    await withFakeHome(async (home) => {
      const copilot = buildPlan("copilot", root);
      expect(copilot).toEqual({
        client: "copilot",
        kind: "file",
        path: join(home, ".copilot", "mcp-config.json"),
        mergeKey: "mcpServers",
        entry: { type: "stdio", command: "orch", args: ["mcp", "serve", "--root", root] },
      });

      const antigravity = buildPlan("antigravity", root);
      expect(antigravity.kind).toBe("file");
      expect(antigravity.kind === "file" && antigravity.path).toBe(join(home, ".gemini", "antigravity-cli", "settings.json"));

      const opencode = buildPlan("opencode", root);
      expect(opencode.kind).toBe("file");
      expect(opencode.kind === "file" && opencode.mergeKey).toBe("mcp");
    });
  });
});

describe("applyPlan", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("plan \"file\" : fusionne dans un fichier existant, sans perdre les autres entrées", async () => {
    await withFakeHome(async (home) => {
      const path = join(home, ".copilot", "mcp-config.json");
      await mkdir(join(home, ".copilot"), { recursive: true });
      await writeFile(path, JSON.stringify({ mcpServers: { autre: { command: "autre-cli" } } }), "utf8");

      await applyPlan(buildPlan("copilot", root));

      const written = JSON.parse(await readFile(path, "utf8"));
      expect(written.mcpServers.autre).toEqual({ command: "autre-cli" });
      expect(written.mcpServers.orch).toEqual({ type: "stdio", command: "orch", args: ["mcp", "serve", "--root", root] });
    });
  });

  it("plan \"file\" : crée le fichier (et son répertoire) s'il n'existe pas", async () => {
    await withFakeHome(async (home) => {
      await applyPlan(buildPlan("copilot", root));
      const written = JSON.parse(await readFile(join(home, ".copilot", "mcp-config.json"), "utf8"));
      expect(written.mcpServers.orch.command).toBe("orch");
    });
  });

  it("plan \"command\" : exécute réellement le binaire (ici un faux \"claude\" sous un PATH maîtrisé)", async () => {
    await withFakeHome(async () => {
      const shimDir = await mkdtemp(join(tmpdir(), "orch-mcp-shim-"));
      const captureFile = join(shimDir, "capture.json");
      const script = `#!/usr/bin/env node\nconst fs = require("fs");\nfs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(2)));\n`;
      const target = join(shimDir, "claude");
      await writeFile(target, script, "utf8");
      await chmod(target, 0o755);

      const previousPath = process.env["PATH"];
      // Comme `packages/cli/test/support.ts` (`withShimmedPath`) : les
      // scripts factices ont pour shebang `/usr/bin/env node`, il faut donc
      // aussi le répertoire du binaire node courant, pas seulement le shim.
      process.env["PATH"] = [shimDir, "/usr/bin", "/bin", dirname(process.execPath)].join(delimiter);
      try {
        await applyPlan(buildPlan("claude", root));
        const captured = JSON.parse(await readFile(captureFile, "utf8"));
        expect(captured).toEqual(["mcp", "add", "orch", "--", "orch", "mcp", "serve", "--root", root]);
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
    root = await mkdtemp(join(tmpdir(), "orch-mcp-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("\"not-registered\" quand le fichier n'existe pas encore", async () => {
    await withFakeHome(async () => {
      const status = await checkMcpStatus("copilot", root);
      expect(status).toEqual({ client: "copilot", registered: "not-registered", detail: expect.stringContaining("Absent de") });
    });
  });

  it("\"registered\" une fois l'entrée présente, sans passer par applyPlan", async () => {
    await withFakeHome(async (home) => {
      const path = join(home, ".copilot", "mcp-config.json");
      await mkdir(join(home, ".copilot"), { recursive: true });
      await writeFile(path, JSON.stringify({ mcpServers: { orch: { command: "orch" } } }), "utf8");

      const status = await checkMcpStatus("copilot", root);
      expect(status.registered).toBe("registered");
    });
  });

  it("claude et codex : \"unknown\", sans lancer le moindre sous-processus", async () => {
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
