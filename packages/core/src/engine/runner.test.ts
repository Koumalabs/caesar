import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@orch/protocol";
import { REPORT_PROTOCOL, readTask, taskPaths } from "@orch/protocol";
import { fileTaskStore, type TaskStore } from "../store.js";
import { garbageCollectWorktrees } from "./gc.js";
import { createQueue } from "./queue.js";

const execFileAsync = promisify(execFile);

/**
 * Remplace le registre fixe (les cinq agents réels) par une version qui sait
 * en plus résoudre `"fake-agent"` / `"fake-agent-native-ro"` vers l'agent
 * factice de test, construit avec `createGenericAgent` — exactement comme le
 * brief le demande ("il se déclare au registre via GenericAgentSpec").
 *
 * Le registre lui-même (`../registry/index.ts`) n'est pas modifié : task 3
 * l'a livré et testé, ce module se contente de le consommer, y compris dans
 * ce contournement de test.
 */
vi.mock("../registry/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../registry/index.js")>();
  const { createGenericAgent } = await import("../registry/generic.js");
  const { fileURLToPath } = await import("node:url");
  const fakeAgentPath = fileURLToPath(new URL("../../test/fixtures/fake-agent.mjs", import.meta.url));

  const fakeAgentDefinition = createGenericAgent({
    id: "fake-agent",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { nativeReadOnly: false },
  });
  const fakeAgentNativeReadOnlyDefinition = createGenericAgent({
    id: "fake-agent-native-ro",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { nativeReadOnly: true },
  });
  const fakeAgentFinalMessageDefinition = createGenericAgent({
    id: "fake-agent-final-message",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { finalMessageFile: true },
  });
  // `mcpInjection: "flag"` : un agent qui sait charger un serveur MCP par
  // ligne de commande — condition nécessaire pour que le runner construise
  // un `Channel` (tâche 9). `createGenericAgent` ne sait pas injecter la
  // configuration MCP lui-même (ce n'est pas un des cinq adaptateurs réels) ;
  // seul `task.channel`, lu directement depuis `task.json`, importe ici —
  // c'est ce que fait le nouveau mode "ask" de l'agent factice.
  const fakeAgentChannelDefinition = createGenericAgent({
    id: "fake-agent-channel",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { mcpInjection: "flag" },
  });

  return {
    ...actual,
    resolveAgentDefinition: (id: string) => {
      if (id === "fake-agent") return fakeAgentDefinition;
      if (id === "fake-agent-native-ro") return fakeAgentNativeReadOnlyDefinition;
      if (id === "fake-agent-final-message") return fakeAgentFinalMessageDefinition;
      if (id === "fake-agent-channel") return fakeAgentChannelDefinition;
      return actual.resolveAgentDefinition(id);
    },
  };
});

/**
 * `vi.hoisted` : un état mutable sûr à référencer depuis l'intérieur d'un
 * `vi.mock` hissé au-dessus de tout le reste du fichier (voir la doc
 * vitest) — un simple `let` déclaré ici serait lu avant son initialisation
 * (TDZ), puisque le mock qui le capture peut s'exécuter dès la résolution
 * des imports hissés, avant que ce module n'ait fini de s'évaluer.
 */
const channelResolutionFailure = vi.hoisted(() => ({ active: false }));

/**
 * Simule l'échec de résolution du binaire du canal retour (`resolveChannelEntry`,
 * `runner.ts`) sans toucher au vrai système de modules ni à l'installation
 * réelle de `@orch/mcp-channel` : seule `require.resolve("@orch/mcp-channel")`
 * est interceptée, et seulement quand `channelResolutionFailure.active` est
 * vrai (activé le temps d'un seul test ci-dessous) — tout le reste de ce
 * fichier continue de résoudre normalement, y compris les tests "canal
 * retour" qui précèdent celui-ci et qui ont besoin d'une résolution réussie.
 */
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (...args: Parameters<typeof actual.createRequire>) => {
      const real = actual.createRequire(...args);
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "resolve") {
            return (id: string, options?: { paths?: string[] | null }) => {
              if (id === "@orch/mcp-channel" && channelResolutionFailure.active) {
                throw new Error("résolution simulée en échec, pour le test de dégradation (tâche 9)");
              }
              return target.resolve(id, options);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

const { runTask, configureChannelLauncher, defaultChannelLauncher } = await import("./runner.js");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initGitRepo(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "orch-test@example.com"]);
  await git(root, ["config", "user.name", "Orch Test"]);
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await git(root, ["add", "a.txt"]);
  await git(root, ["commit", "-q", "-m", "init"]);
}

/**
 * Un dépôt git tout juste initialisé, sans le moindre commit : sa branche
 * n'est pas née et `HEAD` ne désigne rien. `repoRoot` le résout comme n'importe
 * quel dépôt — c'est précisément ce qui rend le cas distinct du « pas un dépôt
 * git » testé juste à côté.
 */
async function initGitRepoWithoutCommit(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "orch-test@example.com"]);
  await git(root, ["config", "user.name", "Orch Test"]);
}

describe("runTask", () => {
  let root: string;
  let store: TaskStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orch-runner-")));
    store = fileTaskStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("règle d'isolation \"auto\"", () => {
    it("write + dépôt git → worktree", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root, queue: createQueue(2) },
        { agentId: "fake-agent", objective: "écrire", mode: "write", workspace: root },
      );

      expect(outcome.record.isolation).toBe("worktree");
      expect(outcome.record.branch).toBe(`orch/${outcome.record.id}`);
      expect(outcome.record.workspace).toBe(join(root, ".orch", "wt", outcome.record.id));
      expect(outcome.record.status).toBe("succeeded");
      expect(outcome.report.status).toBe("success");
      expect(outcome.report.findings).toEqual([]);
    });

    it("protège le worktree contre gc avant que son enregistrement running soit publié", async () => {
      await initGitRepo(root);
      let releaseCreate!: () => void;
      let notifyCreate!: () => void;
      const createReached = new Promise<void>((resolvePromise) => {
        notifyCreate = resolvePromise;
      });
      const createReleased = new Promise<void>((resolvePromise) => {
        releaseCreate = resolvePromise;
      });
      const delayedStore: TaskStore = {
        create: async (record) => {
          notifyCreate();
          await createReleased;
          await store.create(record);
        },
        update: (id, patch) => store.update(id, patch),
        get: (id) => store.get(id),
        list: (filter) => store.list(filter),
      };

      const running = runTask(
        { store: delayedStore, root },
        {
          taskId: "t_demarrage_concurrent",
          agentId: "fake-agent",
          objective: "démarrer pendant gc",
          mode: "write",
          isolation: "worktree",
          workspace: root,
        },
      );
      await createReached;

      await expect(
        runTask(
          { store, root },
          {
            taskId: "t_demarrage_concurrent",
            agentId: "fake-agent",
            objective: "démarrage concurrent avec le même identifiant",
            mode: "write",
            isolation: "worktree",
            workspace: root,
          },
        ),
      ).rejects.toThrow();

      const duringStartup = await garbageCollectWorktrees(root, { force: true });
      expect(duringStartup.entries).toEqual([
        expect.objectContaining({ id: "t_demarrage_concurrent", action: "kept", reason: "active", orphan: true }),
      ]);

      releaseCreate();
      const outcome = await running;
      expect(outcome.record.status).toBe("succeeded");

      const afterCompletion = await garbageCollectWorktrees(root);
      expect(afterCompletion.entries).toEqual([
        expect.objectContaining({ id: "t_demarrage_concurrent", action: "removed", reason: "clean", orphan: false }),
      ]);
    });

    it("write + workspace hors dépôt git → inplace, avec un constat d'isolation dégradée", async () => {
      const outcome = await runTask(
        { store, root, queue: createQueue(2) },
        { agentId: "fake-agent", objective: "écrire", mode: "write", workspace: root },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.branch).toBeUndefined();
      expect(outcome.record.workspace).toBe(root);
      expect(outcome.report.findings).toEqual([expect.objectContaining({ severity: "low" })]);
    });

    it("lecture seule + mode natif appliqué par le CLI → inplace, avec un diff constaté par git status (C2 de la revue finale)", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent-native-ro", objective: "lire", mode: "read-only", workspace: root },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.workspace).toBe(root);
      // Avant C2 de la revue finale, `outcome.diff` restait `undefined` en
      // isolation "inplace" — aucun recoupement n'y était jamais tenté,
      // c'était précisément le trou que "le diff git fait foi" promettait de
      // ne jamais avoir. `diffWorkspaceStatus` (git status avant/après,
      // `worktree.ts`) comble ce trou dès qu'un dépôt git est disponible :
      // ici l'agent n'a rien écrit, le diff est donc défini mais vide.
      expect(outcome.diff).toBeDefined();
      expect(outcome.diff!.isEmpty).toBe(true);
      expect(outcome.record.changes_verified_by).toBe("git");
    });

    it("lecture seule + agent sans mode natif → worktree forcé", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "lire", mode: "read-only", workspace: root },
      );

      expect(outcome.record.isolation).toBe("worktree");
      expect(outcome.diff).toBeDefined();
      expect(outcome.diff!.isEmpty).toBe(true);
    });

    it("worktree demandé explicitement hors dépôt git : échoue clairement plutôt que de dégrader silencieusement", async () => {
      await expect(
        runTask(
          { store, root },
          { agentId: "fake-agent", objective: "écrire", mode: "write", workspace: root, isolation: "worktree" },
        ),
      ).rejects.toThrow(/dépôt git/);
    });

    it("worktree demandé sur un dépôt sans commit : l'erreur nomme la cause et le remède, pas HEAD", async () => {
      // Constaté à l'usage sur un dépôt fraîchement initialisé : la commande
      // échouait sur le message brut de git, « Command failed: git worktree
      // add … HEAD / fatal: invalid reference: HEAD », qui ne dit ni pourquoi
      // ni quoi faire. `repoRoot` réussit ici — c'est bien un dépôt —, seul
      // le point de départ manque.
      await initGitRepoWithoutCommit(root);
      await expect(
        runTask(
          { store, root },
          { agentId: "fake-agent", objective: "écrire", mode: "write", workspace: root, isolation: "worktree" },
        ),
      ).rejects.toThrow(/aucun commit[\s\S]*premier commit/);
    });

    it("write + \"auto\" sur un dépôt sans commit → inplace, avec un constat qui explique le repli", async () => {
      await initGitRepoWithoutCommit(root);
      const outcome = await runTask(
        { store, root, queue: createQueue(2) },
        { agentId: "fake-agent", objective: "écrire", mode: "write", workspace: root },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.branch).toBeUndefined();
      expect(outcome.report.findings).toEqual([
        expect.objectContaining({ severity: "low", detail: expect.stringMatching(/aucun commit/) }),
      ]);
    });

    it("lecture seule sans mode natif sur un dépôt sans commit → inplace, le constat disant que la garantie manque et pourquoi", async () => {
      // Même traitement que le cas jumeau « workspace hors dépôt git » : le
      // worktree que `mustForceWorktree` impose d'ordinaire est ici hors
      // d'atteinte, et la tâche se poursuit sans lui. Ce qui compte alors est
      // que le rapport porte la trace de la garantie manquante, et sa cause.
      await initGitRepoWithoutCommit(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "lire", mode: "read-only", workspace: root },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.report.findings).toEqual([
        expect.objectContaining({ detail: expect.stringMatching(/aucun commit[\s\S]*premier commit/) }),
      ]);
    });
  });

  it("une tâche read-only dont l'agent écrit produit un finding de sévérité high, nommant le fichier", async () => {
    await initGitRepo(root);
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "lecture seule qui n'en est pas une",
        mode: "read-only",
        workspace: root,
        context: JSON.stringify({ files: [{ path: "sournois.txt", content: "je n'aurais pas dû écrire ça" }] }),
      },
    );

    expect(outcome.diff!.isEmpty).toBe(false);
    const high = outcome.report.findings.filter((f) => f.severity === "high");
    expect(high).toHaveLength(1);
    expect(high[0]!.detail).toContain("sournois.txt");
  });

  /**
   * Les quatre tests de couture demandés par la revue finale : ils auraient
   * attrapé C1 à C4 avant fusion. C1 (un agent déclaré en `[[agent]]` tourne
   * de bout en bout via `orch run`) vit dans `packages/cli/src/commands/run.test.ts`,
   * seul niveau où le CLI/`.orch/config.toml` a un sens ; les trois autres
   * sont ici, au niveau du moteur qu'ils exercent directement.
   */
  describe("tests de couture — revue finale", () => {
    it("C2 : report.changes diffère du diff git réel ⇒ un finding apparaît, aussi en isolation \"inplace\" (pas seulement \"worktree\")", async () => {
      // Le pendant "worktree" de ce test existe déjà plus bas
      // ("recoupe une déclaration mensongère avec le diff réel de bout en
      // bout") : avant C2 de la revue finale, aucun recoupement n'était
      // jamais tenté en isolation "inplace" — `report.changes` y restait la
      // déclaration brute de l'agent, sans qu'aucun finding ne signale un
      // mensonge dans un sens ou dans l'autre.
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent",
          objective: "agent qui ment sur ses changements, en inplace",
          mode: "write",
          isolation: "inplace",
          workspace: root,
          context: JSON.stringify({
            files: [{ path: "reel.txt", content: "vraiment écrit" }],
            declaredChanges: [{ path: "invente.txt", action: "modified", summary: "n'existe pas" }],
          }),
        },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.changes_verified_by).toBe("git");
      expect(outcome.report.changes).toEqual([{ path: "reel.txt", action: "created", summary: "" }]);
      const files = outcome.report.findings.map((f) => f.file).sort();
      expect(files).toEqual(["invente.txt", "reel.txt"]);
    });

    it('C3 : un agent read-only qui écrit est détecté même si "inplace" est explicitement demandé (isolation forcée sur "worktree")', async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent", // capabilities.nativeReadOnly === false
          objective: "lecture seule, inplace explicitement demandé malgré tout",
          mode: "read-only",
          isolation: "inplace", // avant C3, cette valeur explicite défaisait silencieusement la contrainte.
          workspace: root,
          context: JSON.stringify({ files: [{ path: "sournois2.txt", content: "toujours pas censé écrire" }] }),
        },
      );

      // La contrainte l'emporte sur la demande explicite : isolation réellement forcée sur "worktree".
      expect(outcome.record.isolation).toBe("worktree");
      const high = outcome.report.findings.filter((f) => f.severity === "high");
      expect(high).toHaveLength(1);
      expect(high[0]!.detail).toContain("sournois2.txt");
      // Le contournement contredit est signalé, pas seulement absorbé en silence.
      expect(outcome.report.findings.some((f) => f.title === "Isolation dégradée")).toBe(true);
    });

    it('C3 : un agent read-only nativement lecture-seule qui écrit quand même est détecté en isolation "inplace" réelle (jamais forcée sur "worktree")', async () => {
      // Cas le plus dur du "quelle que soit l'isolation demandée" : ici
      // l'isolation reste authentiquement "inplace" (agent nativement
      // lecture seule, `mustForceWorktree` ne s'applique pas) — la détection
      // doit donc venir du recoupement `git status` avant/après (C2),
      // jamais d'un worktree.
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent-native-ro", // capabilities.nativeReadOnly === true
          objective: "lecture seule native qui ment sur sa promesse",
          mode: "read-only",
          workspace: root,
          context: JSON.stringify({ files: [{ path: "sournois3.txt", content: "le CLI a un bug" }] }),
        },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.changes_verified_by).toBe("git");
      const high = outcome.report.findings.filter((f) => f.severity === "high");
      expect(high).toHaveLength(1);
      expect(high[0]!.detail).toContain("sournois3.txt");
    });

    it("C4 : max_parallel = 1 (Queue partagée, limite 1) ⇒ deux délégations s'exécutent en série, jamais simultanément", async () => {
      const queue = createQueue(1);
      const concurrentRunningCounts: number[] = [];
      let polling = true;
      const pollLoop = (async () => {
        while (polling) {
          const running = await store.list({ status: ["running"] });
          concurrentRunningCounts.push(running.filter((r) => r.pid !== undefined).length);
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 15));
        }
      })();

      const makeInput = (label: string) => ({
        agentId: "fake-agent",
        objective: `tâche ${label}`,
        mode: "write" as const,
        isolation: "inplace" as const,
        workspace: root,
        context: JSON.stringify({ sleepMs: 200 }),
      });

      const [a, b] = await Promise.all([
        runTask({ store, root, queue }, makeInput("a")),
        runTask({ store, root, queue }, makeInput("b")),
      ]);
      polling = false;
      await pollLoop;

      expect(a.record.status).toBe("succeeded");
      expect(b.record.status).toBe("succeeded");
      // Preuve par constat d'état, pas par chronomètre (même méthode que
      // `packages/mcp-server/src/tools/await.test.ts:79-98`) : jamais plus
      // d'une tâche "running" avec un pid actif à la fois, malgré deux
      // `runTask` lancés en parallèle avec `Promise.all` — exactement la
      // garantie que `policy.max_parallel` doit fournir, et que
      // `RunnerDeps.queue` ne câblait jusqu'ici nulle part (C4).
      expect(Math.max(...concurrentRunningCounts)).toBeLessThanOrEqual(1);
      // Le test n'a de sens que s'il a effectivement observé une tâche
      // active pendant l'exécution : sinon "jamais plus d'une" serait vrai
      // par défaut d'observation, pas par la garantie testée.
      expect(concurrentRunningCounts.some((n) => n === 1)).toBe(true);
    });

    it("C4 (témoin) : sans limite partagée, les deux mêmes délégations tournent bien simultanément — la Queue de limite 1 ci-dessus est donc bien ce qui sérialise", async () => {
      const concurrentRunningCounts: number[] = [];
      let polling = true;
      const pollLoop = (async () => {
        while (polling) {
          const running = await store.list({ status: ["running"] });
          concurrentRunningCounts.push(running.filter((r) => r.pid !== undefined).length);
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 15));
        }
      })();

      const makeInput = (label: string) => ({
        agentId: "fake-agent",
        objective: `tâche témoin ${label}`,
        mode: "write" as const,
        isolation: "inplace" as const,
        workspace: root,
        context: JSON.stringify({ sleepMs: 200 }),
      });

      // Aucune Queue partagée (`{ store, root, queue: undefined }`) : les deux
      // délégations ne sont bridées par rien.
      await Promise.all([
        runTask({ store, root, queue: undefined }, makeInput("a")),
        runTask({ store, root, queue: undefined }, makeInput("b")),
      ]);
      polling = false;
      await pollLoop;

      expect(concurrentRunningCounts.some((n) => n === 2)).toBe(true);
    });
  });

  it("une tâche dont l'agent n'écrit aucun rapport produit un rapport synthétisé", async () => {
    await initGitRepo(root);
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "agent qui ignore le contrat",
        mode: "write",
        workspace: root,
        context: JSON.stringify({ mode: "silent" }),
      },
    );

    expect(outcome.source).toBe("synthesized");
    expect(outcome.record.status).toBe("succeeded");
    expect(outcome.report.status).toBe("success");
  });

  it("un agent capable de finalMessageFile est câblé de bout en bout : le runner lui désigne le fichier, il l'utilise", async () => {
    await initGitRepo(root);
    const embedded = {
      protocol: REPORT_PROTOCOL,
      task_id: "peu importe, resolveReport ne s'y fie pas",
      status: "success",
      summary: "déposé par le CLI dans final-message.txt, jamais dans report.json",
      changes: [],
    };
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent-final-message",
        objective: "agent qui rapporte par fichier de message final",
        mode: "write",
        workspace: root,
        // "silent" : aucun report.json écrit, pour prouver que le rapport
        // vient bien de final-message.txt et de rien d'autre.
        context: JSON.stringify({ mode: "silent", finalMessage: JSON.stringify(embedded) }),
      },
    );

    expect(outcome.source).toBe("extracted");
    expect(outcome.report.summary).toBe("déposé par le CLI dans final-message.txt, jamais dans report.json");
  });

  it("renseigne le pid du sous-processus pendant l'exécution puis l'efface à la fin", async () => {
    const runPromise = runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "vérifie le cycle de vie du pid",
        mode: "write",
        workspace: root,
        isolation: "inplace",
        timeoutMs: 300,
        context: JSON.stringify({ mode: "hang", sleepMs: 5000 }),
      },
    );

    // Attend que le pid apparaisse dans le store, pendant que la tâche tourne encore.
    let seenPid: number | undefined;
    for (let i = 0; i < 100 && seenPid === undefined; i++) {
      const records = await store.list({ status: ["running"] });
      seenPid = records[0]?.pid;
      if (seenPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(seenPid).toBeGreaterThan(0);

    const outcome = await runPromise;
    expect(outcome.record.pid).toBeUndefined();
  });

  it("taskId fourni par l'appelant : utilisé tel quel, sans en générer un autre", async () => {
    const outcome = await runTask(
      { store, root },
      { agentId: "fake-agent", objective: "identifiant imposé", mode: "write", workspace: root, taskId: "t_imposed" },
    );

    expect(outcome.record.id).toBe("t_imposed");
    expect(outcome.record.task_dir).toBe(join(root, ".orch", "tasks", "t_imposed"));
    expect(await store.get("t_imposed")).not.toBeNull();
  });

  it("un signal déjà déclenché à l'entrée n'engage même pas l'isolation : aucun worktree créé, statut cancelled", async () => {
    await initGitRepo(root);
    const controller = new AbortController();
    controller.abort();

    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "signal déjà abandonné avant le lancement",
        // write + dépôt git : la règle d'isolation "auto" aurait normalement
        // créé un worktree. Le garde doit intervenir avant que cela n'arrive.
        mode: "write",
        workspace: root,
        signal: controller.signal,
      },
    );

    expect(outcome.record.status).toBe("cancelled");
    expect(outcome.record.branch).toBeUndefined();
    expect(outcome.diff).toBeUndefined();
    expect(outcome.report.status).toBe("failed");
    await expect(access(join(root, ".orch", "wt"))).rejects.toThrow();
  });

  it("onEvent reçoit les événements au fil de l'eau, avant que runTask ne résolve", async () => {
    const seenBeforeResolution: string[] = [];
    let resolved = false;

    const runPromise = runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "événements en direct",
        mode: "write",
        workspace: root,
        onEvent: (event) => seenBeforeResolution.push(event.type),
      },
    ).then((outcome) => {
      resolved = true;
      return outcome;
    });

    // Le premier événement ("started") doit être observable avant même que
    // `runTask` ait fini de résoudre — c'est ce qui distingue un flux en
    // direct d'une relecture après coup.
    for (let i = 0; i < 100 && seenBeforeResolution.length === 0; i++) {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5));
    }
    expect(seenBeforeResolution).toContain("started");
    expect(resolved).toBe(false);

    const outcome = await runPromise;
    expect(outcome.record.status).toBe("succeeded");
    expect(seenBeforeResolution).toContain("finished");
  });

  it("un AbortSignal annulé pendant l'exécution interrompt la tâche sans laisser de processus fils", async () => {
    const controller = new AbortController();
    const runPromise = runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "tâche interrompue via AbortSignal",
        mode: "write",
        workspace: root,
        signal: controller.signal,
        context: JSON.stringify({ mode: "hang", sleepMs: 30_000 }),
      },
    );

    // Laisse le sous-processus réellement démarrer avant d'annuler.
    for (let i = 0; i < 100; i++) {
      const [record] = await store.list({ status: ["running"] });
      if (record?.pid !== undefined) break;
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 20));
    }
    controller.abort();

    const outcome = await runPromise;
    expect(outcome.record.status).toBe("cancelled");
    expect(outcome.record.pid).toBeUndefined();
  });

  it("recoupe une déclaration mensongère avec le diff réel de bout en bout", async () => {
    await initGitRepo(root);
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "agent qui ment sur ses changements",
        mode: "write",
        workspace: root,
        context: JSON.stringify({
          files: [{ path: "reel.txt", content: "vraiment écrit" }],
          declaredChanges: [{ path: "invente.txt", action: "modified", summary: "n'existe pas" }],
        }),
      },
    );

    expect(outcome.source).toBe("file");
    expect(outcome.report.changes).toEqual([{ path: "reel.txt", action: "created", summary: "" }]);
    const files = outcome.report.findings.map((f) => f.file).sort();
    expect(files).toEqual(["invente.txt", "reel.txt"]);
  });

  describe("canal retour (tâche 9)", () => {
    it("channel: true + agent qui sait charger un serveur MCP : task.channel est construit, le palier de rapport devient \"channel\"", async () => {
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent-channel", objective: "avec canal", mode: "write", workspace: root, channel: true },
      );

      expect(outcome.record.report_via).toBe("channel");
      const task = await readTask(taskPaths(outcome.record.task_dir));
      expect(task.channel).toEqual({
        transport: "mcp-stdio",
        command: process.execPath,
        args: [expect.stringMatching(/bin\.js$/), outcome.record.task_dir],
        server_name: "orch",
      });
    });

    it("channel absent (défaut) : task.channel reste vide même pour un agent qui le supporterait", async () => {
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent-channel", objective: "sans canal demandé", mode: "write", workspace: root },
      );

      expect(outcome.record.report_via).not.toBe("channel");
      const task = await readTask(taskPaths(outcome.record.task_dir));
      expect(task.channel).toBeFalsy();
    });

    it("dégradation : channel: true pour un agent sans mcpInjection est ignoré silencieusement, la tâche aboutit quand même", async () => {
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "canal demandé mais non supporté", mode: "write", workspace: root, channel: true },
      );

      expect(outcome.record.status).toBe("succeeded");
      expect(outcome.record.report_via).not.toBe("channel");
      const task = await readTask(taskPaths(outcome.record.task_dir));
      expect(task.channel).toBeFalsy();
    });

    it("dégradation : une résolution du binaire du canal en échec n'empêche pas la tâche d'aboutir, par un palier inférieur", async () => {
      // Cas distinct des deux précédents : ici, l'agent supporte bien
      // mcpInjection et le canal est bien demandé — c'est sa construction
      // elle-même (`buildChannel`/`resolveChannelEntry`, `runner.ts`) qui
      // échoue (installation cassée, simulée via le mock `node:module`
      // ci-dessus), exerçant réellement la branche `catch` plutôt qu'un cas
      // voisin où l'agent ignore un canal par ailleurs construit avec succès.
      channelResolutionFailure.active = true;
      try {
        const outcome = await runTask(
          { store, root },
          { agentId: "fake-agent-channel", objective: "résolution du binaire cassée", mode: "write", workspace: root, channel: true },
        );

        expect(outcome.record.status).toBe("succeeded");
        expect(outcome.record.report_via).not.toBe("channel");
        expect(outcome.source).not.toBe("channel");
        const task = await readTask(taskPaths(outcome.record.task_dir));
        expect(task.channel).toBeFalsy();
      } finally {
        channelResolutionFailure.active = false;
      }
    });

    it("configureChannelLauncher (tâche 12) : un lanceur personnalisé remplace la résolution par défaut", async () => {
      // Exerce le point d'extension à travers la vraie façade (`runTask`),
      // pas en appelant une fonction interne directement — voir le rapport
      // de la tâche 12 : un test qui contournerait `configureChannelLauncher`
      // pour construire `task.channel` à la main ne protégerait rien de ce
      // que `bun-entry.ts` fait réellement en production.
      configureChannelLauncher((taskDir): Channel => ({
        transport: "mcp-stdio",
        command: "orch",
        args: ["channel", "serve", "--task-dir", taskDir],
        server_name: "orch",
      }));
      try {
        const outcome = await runTask(
          { store, root },
          { agentId: "fake-agent-channel", objective: "lanceur personnalisé", mode: "write", workspace: root, channel: true },
        );

        expect(outcome.record.report_via).toBe("channel");
        const task = await readTask(taskPaths(outcome.record.task_dir));
        expect(task.channel).toEqual({
          transport: "mcp-stdio",
          command: "orch",
          args: ["channel", "serve", "--task-dir", outcome.record.task_dir],
          server_name: "orch",
        });
      } finally {
        configureChannelLauncher(defaultChannelLauncher);
      }
    });

    it("configureChannelLauncher (tâche 12) : un lanceur personnalisé qui lève dégrade sans faire échouer la tâche", async () => {
      // Même garantie que pour `resolveChannelEntry` (test précédent), mais
      // côté lanceur injecté : le brief l'exige explicitement ("la garantie
      // […] doit tenir dans les deux mondes"), donc dans les deux sources
      // d'échec possibles, pas seulement la résolution par défaut.
      configureChannelLauncher(() => {
        throw new Error("lanceur personnalisé cassé, simulé pour ce test");
      });
      try {
        const outcome = await runTask(
          { store, root },
          { agentId: "fake-agent-channel", objective: "lanceur personnalisé cassé", mode: "write", workspace: root, channel: true },
        );

        expect(outcome.record.status).toBe("succeeded");
        expect(outcome.record.report_via).not.toBe("channel");
        expect(outcome.source).not.toBe("channel");
        const task = await readTask(taskPaths(outcome.record.task_dir));
        expect(task.channel).toBeFalsy();
      } finally {
        configureChannelLauncher(defaultChannelLauncher);
      }
    });
  });
});
