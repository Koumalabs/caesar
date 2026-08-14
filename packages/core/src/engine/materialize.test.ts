import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorktreeConfig } from "../config.js";
import { createWorktree } from "./worktree.js";
import { detectUntrackedNeeds, isUnderPath, materializeUntracked, runSetup } from "./materialize.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

function request(overrides: Partial<WorktreeConfig> = {}): WorktreeConfig {
  return { copy: [], link: [], setup: [], ...overrides };
}

describe("materializeUntracked", () => {
  let root: string;
  let worktree: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-materialize-"));
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "caesar-test@example.com"]);
    await git(root, ["config", "user.name", "Caesar Test"]);
    await writeFile(join(root, ".gitignore"), "node_modules/\n.env\n.superpowers/\ncache/\n", "utf8");
    await writeFile(join(root, "a.txt"), "hello\n", "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "init"]);
    worktree = (await createWorktree(root, "t_mat")).path;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedIgnored(path: string, content = "contenu\n"): Promise<void> {
    await mkdir(join(root, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."), { recursive: true });
    await writeFile(join(root, path), content, "utf8");
  }

  it("copie un répertoire ignoré et rend le mécanisme employé", async () => {
    // Le cas qui rendait l'isolation inexploitable : `node_modules` est
    // ignoré par git, donc absent du worktree, donc rien ne s'y lance.
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

    const result = await materializeUntracked(root, worktree, request({ copy: ["node_modules"] }));

    expect(result.materialized).toHaveLength(1);
    expect(result.materialized[0]!.path).toBe("node_modules");
    expect(["clone", "copy"]).toContain(result.materialized[0]!.via);
    expect(result.excluded).toEqual(["node_modules"]);
    expect(result.shared).toEqual([]);
    expect(await readFile(join(worktree, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("la copie est réellement isolée : écrire dans le worktree ne touche pas le workspace", async () => {
    // La propriété qui distingue `copy` de `link`, et qui justifie d'en faire
    // le défaut : sur un système copy-on-write le clone ne coûte rien, et le
    // sous-agent reste malgré tout enfermé chez lui.
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "marqueur.txt"), "original\n", "utf8");

    await materializeUntracked(root, worktree, request({ copy: ["node_modules"] }));
    await writeFile(join(worktree, "node_modules", "marqueur.txt"), "modifié par l'agent\n", "utf8");

    expect(await readFile(join(root, "node_modules", "marqueur.txt"), "utf8")).toBe("original\n");
  });

  it("copie un fichier ignoré, pas seulement un répertoire", async () => {
    await seedIgnored(".env", "SECRET=1\n");
    const result = await materializeUntracked(root, worktree, request({ copy: [".env"] }));
    expect(result.excluded).toEqual([".env"]);
    expect(await readFile(join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("pose un lien pour `link`, et le signale comme non isolé", async () => {
    await mkdir(join(root, "cache"), { recursive: true });
    await writeFile(join(root, "cache", "gros.bin"), "x".repeat(64), "utf8");

    const result = await materializeUntracked(root, worktree, request({ link: ["cache"] }));

    expect(result.materialized).toEqual([{ path: "cache", via: "link" }]);
    // Le partage doit être dit : deux tâches simultanées y écrivent au même
    // endroit, et ce qu'elles y cassent, elles le cassent pour le workspace.
    expect(result.shared).toEqual(["cache"]);
    expect((await lstat(join(worktree, "cache"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(worktree, "cache"))).toContain("cache");
  });

  it("crée les répertoires intermédiaires d'un chemin imbriqué", async () => {
    await mkdir(join(root, "packages", "api", "node_modules"), { recursive: true });
    await writeFile(join(root, "packages", "api", "node_modules", "x.js"), "1\n", "utf8");
    await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");

    const result = await materializeUntracked(root, worktree, request({ copy: ["packages/api/node_modules"] }));
    expect(result.excluded).toEqual(["packages/api/node_modules"]);
    expect(await readFile(join(worktree, "packages", "api", "node_modules", "x.js"), "utf8")).toBe("1\n");
  });

  describe("ce qui est écarté, et pourquoi", () => {
    it("absent du workspace : rien à poser", async () => {
      const result = await materializeUntracked(root, worktree, request({ copy: ["node_modules"] }));
      expect(result.materialized).toEqual([]);
      expect(result.skipped).toEqual([expect.objectContaining({ path: "node_modules", reason: "absent" })]);
    });

    it("suivi par git : jamais écrasé — un lien ferait écrire l'agent dans le dépôt principal", async () => {
      // Le pire cas possible, et la raison de l'ordre des vérifications : un
      // lien posé sur un chemin suivi rouvrirait exactement le défaut que
      // toute cette correction ferme.
      const result = await materializeUntracked(root, worktree, request({ link: ["a.txt"] }));
      expect(result.materialized).toEqual([]);
      expect(result.skipped[0]).toMatchObject({ path: "a.txt", reason: "tracked" });
      expect(result.skipped[0]!.detail).toContain("dépôt principal");
      // Le fichier suivi du worktree reste celui de git, intact.
      expect((await lstat(join(worktree, "a.txt"))).isSymbolicLink()).toBe(false);
    });

    it("ni suivi ni ignoré : le poser polluerait le diff qui fait foi", async () => {
      await writeFile(join(root, "brouillon.txt"), "non suivi, non ignoré\n", "utf8");
      const result = await materializeUntracked(root, worktree, request({ copy: ["brouillon.txt"] }));
      expect(result.materialized).toEqual([]);
      expect(result.skipped[0]).toMatchObject({ path: "brouillon.txt", reason: "not-ignored" });
      expect(result.skipped[0]!.detail).toContain(".gitignore");
    });

    it("déjà présent dans le worktree : laissé tel quel", async () => {
      await mkdir(join(root, "node_modules"), { recursive: true });
      await writeFile(join(root, "node_modules", "x.js"), "workspace\n", "utf8");
      await mkdir(join(worktree, "node_modules"), { recursive: true });
      await writeFile(join(worktree, "node_modules", "x.js"), "déjà là\n", "utf8");

      const result = await materializeUntracked(root, worktree, request({ copy: ["node_modules"] }));
      expect(result.skipped[0]).toMatchObject({ path: "node_modules", reason: "already-present" });
      expect(await readFile(join(worktree, "node_modules", "x.js"), "utf8")).toBe("déjà là\n");
    });

    it("un même chemin en copy et en link : la copie l'emporte, puisqu'elle isole", async () => {
      await mkdir(join(root, "node_modules"), { recursive: true });
      await writeFile(join(root, "node_modules", "x.js"), "1\n", "utf8");

      const result = await materializeUntracked(root, worktree, request({ copy: ["node_modules"], link: ["node_modules"] }));
      expect(result.materialized).toHaveLength(1);
      expect(result.materialized[0]!.via).not.toBe("link");
      expect(result.shared).toEqual([]);
      expect((await lstat(join(worktree, "node_modules"))).isSymbolicLink()).toBe(false);
    });

    it("chaque constat porte une phrase lisible, jamais un code nu", async () => {
      const result = await materializeUntracked(root, worktree, request({ copy: ["node_modules", "a.txt"] }));
      for (const entry of result.skipped) {
        expect(entry.detail.length).toBeGreaterThan(20);
        expect(entry.detail).toContain(entry.path);
      }
    });
  });

  describe("configuration invalide : lève, plutôt que d'écarter", () => {
    // Un chemin invalide n'est pas une circonstance d'exécution : c'est une
    // erreur que l'auteur du fichier doit voir.
    const cases: [string, WorktreeConfig][] = [
      ["absolu", request({ copy: ["/etc/passwd"] })],
      ["remontée", request({ copy: ["../ailleurs"] })],
      [".git", request({ copy: [".git"] })],
      [".caesar", request({ link: [".caesar/state"] })],
      ["vide", request({ copy: [""] })],
    ];
    for (const [name, cfg] of cases) {
      it(name, async () => {
        await expect(materializeUntracked(root, worktree, cfg)).rejects.toThrow(/invalide/);
      });
    }

    it("ne pose rien du tout quand une seule entrée est invalide", async () => {
      // La validation passe sur tout le plan avant la première écriture :
      // un atelier à moitié monté serait pire qu'un refus net.
      await mkdir(join(root, "node_modules"), { recursive: true });
      await expect(
        materializeUntracked(root, worktree, request({ copy: ["node_modules", "../dehors"] })),
      ).rejects.toThrow();
      await expect(lstat(join(worktree, "node_modules"))).rejects.toThrow();
    });
  });
});

describe("runSetup", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "caesar-setup-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lance les commandes dans le worktree, dans l'ordre", async () => {
    const result = await runSetup(dir, ["echo un > un.txt", "echo deux > deux.txt"]);
    expect(result.failure).toBeUndefined();
    expect(result.ran).toEqual(["echo un > un.txt", "echo deux > deux.txt"]);
    expect((await readFile(join(dir, "un.txt"), "utf8")).trim()).toBe("un");
    expect((await readFile(join(dir, "deux.txt"), "utf8")).trim()).toBe("deux");
  });

  it("passe par un shell : enchaînements et redirections fonctionnent", async () => {
    // Ce que les projets écrivent réellement ici ressemble à
    // `npm ci && npm run build`.
    const result = await runSetup(dir, ["mkdir -p a/b && echo ok > a/b/c.txt"]);
    expect(result.failure).toBeUndefined();
    expect((await readFile(join(dir, "a", "b", "c.txt"), "utf8")).trim()).toBe("ok");
  });

  it("s'arrête à la première commande en échec, et ne lance pas la suivante", async () => {
    const result = await runSetup(dir, ["echo avant > avant.txt", "exit 3", "echo apres > apres.txt"]);
    expect(result.ran).toEqual(["echo avant > avant.txt"]);
    expect(result.failure).toMatchObject({ command: "exit 3", exitCode: 3 });
    await expect(readFile(join(dir, "apres.txt"), "utf8")).rejects.toThrow();
  });

  it("rend la sortie de la commande en échec, pour que le motif suffise à comprendre", async () => {
    const result = await runSetup(dir, ["echo 'cause profonde' >&2; exit 1"]);
    expect(result.failure!.output).toContain("cause profonde");
  });

  it("aucune commande : n'échoue pas", async () => {
    expect(await runSetup(dir, [])).toEqual({ ran: [] });
  });
});

describe("detectUntrackedNeeds", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-detect-"));
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "caesar-test@example.com"]);
    await git(root, ["config", "user.name", "Caesar Test"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function commitIgnore(lines: string): Promise<void> {
    await writeFile(join(root, ".gitignore"), lines, "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "init"]);
  }

  it("projet nu : rien du tout, plutôt qu'une section vide", async () => {
    // Une section vide ferait croire à un réglage. `caesar init` n'écrit alors
    // rien.
    await commitIgnore("");
    expect(await detectUntrackedNeeds(root)).toBeNull();
  });

  it("projet pnpm : node_modules et la commande pnpm", async () => {
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    await commitIgnore("node_modules/\n");
    await mkdir(join(root, "node_modules"), { recursive: true });

    const detected = await detectUntrackedNeeds(root);
    expect(detected).toEqual({ copy: ["node_modules"], link: [], setup: ["pnpm install --frozen-lockfile --prefer-offline"] });
  });

  it("le marqueur le plus spécifique fixe la commande : un projet pnpm ne reçoit pas npm install", async () => {
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await writeFile(join(root, "package-lock.json"), "{}\n", "utf8");
    await commitIgnore("node_modules/\n");
    await mkdir(join(root, "node_modules"), { recursive: true });

    const detected = await detectUntrackedNeeds(root);
    expect(detected!.setup).toEqual(["npm ci"]);
  });

  it("ne propose que ce qui existe : pas de node_modules, pas d'entrée copy", async () => {
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await commitIgnore("node_modules/\n");

    const detected = await detectUntrackedNeeds(root);
    expect(detected!.copy).toEqual([]);
    expect(detected!.setup).toEqual(["npm install"]);
  });

  it("ne propose jamais un chemin que git ne veut pas ignorer", async () => {
    // La détection applique en amont exactement les règles que la pose
    // exigera : proposer un chemin non ignoré polluerait le diff qui fait foi,
    // et `caesar gc` ne nettoierait plus jamais ce worktree.
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await commitIgnore("# rien d'ignoré\n");
    await mkdir(join(root, "node_modules"), { recursive: true });

    const detected = await detectUntrackedNeeds(root);
    expect(detected!.copy).toEqual([]);
  });

  it("ne propose jamais un chemin suivi par git", async () => {
    // Proposer un chemin suivi rouvrirait le défaut d'origine : l'agent
    // écrirait dans le dépôt principal.
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "commite.js"), "1\n", "utf8");
    await commitIgnore("");

    const detected = await detectUntrackedNeeds(root);
    expect(detected!.copy).toEqual([]);
  });

  it("emporte un .env ignoré, quel que soit l'écosystème", async () => {
    await commitIgnore(".env\n");
    await writeFile(join(root, ".env"), "SECRET=1\n", "utf8");
    expect((await detectUntrackedNeeds(root))!.copy).toEqual([".env"]);
  });

  it("projet Rust : target, sans commande", async () => {
    await writeFile(join(root, "Cargo.toml"), "[package]\n", "utf8");
    await commitIgnore("target/\n");
    await mkdir(join(root, "target"), { recursive: true });

    expect(await detectUntrackedNeeds(root)).toEqual({ copy: ["target"], link: [], setup: [] });
  });

  it("ne propose jamais de lien : la copie isole, le lien non", async () => {
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await commitIgnore("node_modules/\n");
    await mkdir(join(root, "node_modules"), { recursive: true });

    expect((await detectUntrackedNeeds(root))!.link).toEqual([]);
  });

  it("ce qu'elle propose, materializeUntracked sait le poser", async () => {
    // La propriété qui lie les deux fonctions : une détection qui proposerait
    // ce que la pose écarte produirait un fichier de configuration dont chaque
    // exécution se plaindrait.
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await commitIgnore("node_modules/\n.env\n");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "x.js"), "1\n", "utf8");
    await writeFile(join(root, ".env"), "SECRET=1\n", "utf8");

    const detected = (await detectUntrackedNeeds(root))!;
    const worktree = (await createWorktree(root, "t_detect")).path;
    const result = await materializeUntracked(root, worktree, detected);

    expect(result.skipped).toEqual([]);
    expect(result.excluded.sort()).toEqual([".env", "node_modules"]);
  });
});

describe("isUnderPath", () => {
  it("reconnaît un chemin exact et ses descendants", () => {
    expect(isUnderPath("node_modules", "node_modules")).toBe(true);
    expect(isUnderPath("node_modules/pkg/index.js", "node_modules")).toBe(true);
    expect(isUnderPath("packages/api/node_modules/x", "packages/api/node_modules")).toBe(true);
  });

  it("compare par segments, jamais par préfixe de chaîne", () => {
    // `node_modules-old` n'est pas un enfant de `node_modules` : une
    // comparaison de chaînes nue l'aurait exclu du diff par erreur.
    expect(isUnderPath("node_modules-old/x", "node_modules")).toBe(false);
    expect(isUnderPath("autre/node_modules", "node_modules")).toBe(false);
  });
});
