import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeIo, withFakeAgentAsBin, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runPolicyDeny } from "./policy.js";
import { runRun } from "./run.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from "../output.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "orch-test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Orch Test"], { cwd: root });
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await execFileAsync("git", ["add", "a.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
}

describe("orch run", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-run-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("aller-retour complet avec un agent factice substitué au vrai binaire de \"codex\"", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepo(root);
        const code = await runRun(
          root,
          "écrire un fichier",
          { agent: "codex", mode: "write", isolation: "inplace", json: true },
          io,
        );
        expect(code).toBe(EXIT_OK);
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.status).toBe("succeeded");
        expect(parsed.report.status).toBe("success");
        expect(parsed.report_source).toBe("file");
      }),
    );
  }, 20_000);

  it("--json ne produit rien d'autre qu'un JSON valide sur stdout, sans ANSI", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepo(root);
        const code = await runRun(root, "tâche", { agent: "codex", mode: "write", isolation: "inplace", json: true }, io);
        expect(code).toBe(EXIT_OK);
        expect(() => JSON.parse(io.stdoutText())).not.toThrow();
        expect(io.stdoutText()).not.toMatch(/\x1b\[/);
        expect(io.stderrText()).toBe("");
      }),
    );
  }, 20_000);

  it("un agent refusé par la politique sort en code 2 avec le motif rendu par @orch/core, mot pour mot", async () => {
    await withFakeHome(async () => {
      await runPolicyDeny(root, "codex", {}, makeIo());
      const code = await runRun(root, "tâche", { agent: "codex" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText().trim()).toBe(
        'Agent "codex" refusé : présent dans la liste "denied" de la politique.',
      );
    });
  });

  it("--role inconnu : code d'usage, message clair", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "tâche", { role: "inexistant" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/inexistant/);
    });
  });

  it("ni --agent ni --role : code d'usage", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "tâche", {}, io);
      expect(code).toBe(EXIT_USAGE);
    });
  });

  it("--agent inconnu du catalogue : code d'usage", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "tâche", { agent: "agent-fantome" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/inconnu/);
    });
  });

  it("--mode invalide : code d'usage, sans lancer quoi que ce soit", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "tâche", { agent: "codex", mode: "readonly" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--mode/);
    });
  });

  it("--isolation invalide : code d'usage", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "tâche", { agent: "codex", isolation: "bogus" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--isolation/);
    });
  });

  it("--timeout invalide : code d'usage avec le message de parseDuration", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "tâche", { agent: "codex", timeout: "3 fortnights" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/Durée invalide/);
    });
  });

  it("un agent qui échoue (exit non nul) fait sortir la commande en code 1", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepo(root);
        const code = await runRun(
          root,
          "tâche",
          { agent: "codex", mode: "write", isolation: "inplace", json: true, context: JSON.stringify({ mode: "fail" }) },
          io,
        );
        expect(code).toBe(EXIT_RUNTIME);
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.status).toBe("failed");
      }),
    );
  }, 20_000);

  it("--context @fichier lit le fichier désigné", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepo(root);
        const contextFile = join(root, "contexte.txt");
        await writeFile(contextFile, JSON.stringify({ summary: "depuis un fichier" }), "utf8");

        const code = await runRun(
          root,
          "tâche",
          { agent: "codex", mode: "write", isolation: "inplace", json: true, context: `@${contextFile}` },
          io,
        );
        expect(code).toBe(EXIT_OK);
      }),
    );
  }, 20_000);
});
