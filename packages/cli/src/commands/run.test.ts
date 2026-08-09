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

  it("--channel active le canal retour : le palier de rapport devient \"channel\" (tâche 9)", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepo(root);
        const code = await runRun(
          root,
          "écrire un fichier, avec canal",
          { agent: "codex", mode: "write", isolation: "inplace", json: true, channel: true },
          io,
        );
        expect(code).toBe(EXIT_OK);
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.status).toBe("succeeded");
        // "channel" plutôt que "file" (comparer à la première tâche de ce
        // fichier, identique sans --channel) : preuve que le flag a bien
        // atteint `runTask` via `RunTaskInput.channel`, et que "codex"
        // (mcpInjection: "flag") le supporte.
        expect(parsed.report_source).toBe("channel");
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

  it("ni --agent ni --role : code d'usage, message nommant les deux flags", async () => {
    await withFakeHome(async () => {
      const code = await runRun(root, "tâche", {}, io);
      expect(code).toBe(EXIT_USAGE);
      // Message propre au CLI (nomme les flags), pas le motif générique que
      // rend `resolveDelegation` pour ses autres appelants (voir le rapport
      // de correction de la tâche 7 — perdu sans bruit lors de l'extraction,
      // restauré par la revue).
      expect(io.stderrText().trim()).toBe("Précisez --agent <id> ou --role <name>.");
    });
  });

  it("--mode invalide l'emporte sur --role inconnu : la validation de forme sort avant toute résolution", async () => {
    await withFakeHome(async () => {
      // Fixe la précédence entérinée par la revue de la tâche 7 : les
      // validations de forme (--mode, --isolation), qui ne nécessitent
      // aucune E/S, sortent avant même de tenter de résoudre --role — que
      // celui-ci soit ou non valide. Avant l'extraction de
      // `resolveDelegation`, l'ordre inverse aurait rendu "Rôle inconnu"
      // ici ; ce test aurait détecté la régression de précédence relevée en
      // revue.
      const code = await runRun(root, "tâche", { role: "inexistant", mode: "bogus" }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toMatch(/--mode/);
      expect(io.stderrText()).not.toMatch(/inexistant/);
      expect(io.stderrText()).not.toMatch(/[Rr]ôle inconnu/);
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

  it("l'avancement (mode humain) est émis pendant l'exécution, pas seulement relu à la fin", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepo(root);
        let settled = false;
        const runPromise = runRun(
          root,
          "tâche suivie en direct",
          { agent: "codex", mode: "write", isolation: "inplace", context: JSON.stringify({ mode: "hang", sleepMs: 500 }) },
          io,
        ).then((code) => {
          settled = true;
          return code;
        });

        // La ligne "[démarrage]" (dérivée de l'événement "started") doit
        // apparaître alors que `runRun` est encore en cours d'exécution —
        // c'est ce qui distingue un affichage en direct (onEvent) d'une
        // relecture après coup.
        for (let i = 0; i < 100 && !io.stdoutText().includes("[démarrage]"); i++) {
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10));
        }
        expect(io.stdoutText()).toContain("[démarrage]");
        expect(settled).toBe(false);

        const code = await runPromise;
        expect(code).toBe(EXIT_OK);
      }),
    );
  }, 20_000);

  it("SIGINT interrompt proprement une tâche en cours, sans laisser de processus fils", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async (shimDir) => {
        await initGitRepo(root);
        const shimPath = join(shimDir, "codex");

        const runPromise = runRun(
          root,
          "tâche interrompue",
          { agent: "codex", mode: "write", isolation: "inplace", context: JSON.stringify({ mode: "hang", sleepMs: 30_000 }) },
          io,
        );

        for (let i = 0; i < 100 && !io.stdoutText().includes("[démarrage]"); i++) {
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10));
        }
        expect(io.stdoutText()).toContain("[démarrage]");

        // `process.emit` invoque directement les gestionnaires enregistrés via
        // `process.on("SIGINT", ...)`, sans passer par le signal OS réel — on
        // exerce exactement le même code que Ctrl-C déclencherait, sans risquer
        // d'affecter le process de test lui-même ou d'autres fichiers de test
        // exécutés en parallèle.
        process.emit("SIGINT", "SIGINT");

        // Preuve que le signal a réellement atteint et terminé le
        // sous-processus, bien avant les 30 s de `sleepMs`.
        const code = await runPromise;
        expect(code).toBe(EXIT_RUNTIME);
        expect(io.stderrText()).toMatch(/Interruption demandée/);

        try {
          const { stdout } = await execFileAsync("pgrep", ["-f", shimPath]);
          expect(stdout.trim()).toBe("");
        } catch (error) {
          // pgrep sort en erreur (code 1) quand rien ne correspond : c'est le résultat attendu.
          expect((error as { code?: number }).code).toBe(1);
        }
      }),
    );
  }, 20_000);
});
