import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveRole, saveLayer } from "@orch/core";
import { defaultPromptFileFor, readPromptFile, validatePromptFile, writePromptFile } from "./prompt-file";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orch-prompt-file-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("lecture", () => {
  it("un fichier absent n'est pas une erreur : contenu vide, et il le dit", async () => {
    const file = await readPromptFile(root, "roles/reviewer.md");
    expect(file.exists).toBe(false);
    expect(file.content).toBe("");
    expect(file.path).toBe(join(root, ".orch", "roles", "reviewer.md"));
  });

  it("rend le contenu et le chemin absolu", async () => {
    await mkdir(join(root, ".orch", "roles"), { recursive: true });
    await writeFile(join(root, ".orch", "roles", "reviewer.md"), "Tu es strict.", "utf8");
    const file = await readPromptFile(root, "roles/reviewer.md");
    expect(file).toEqual({ path: join(root, ".orch", "roles", "reviewer.md"), content: "Tu es strict.", exists: true });
  });
});

describe("écriture", () => {
  it("crée les répertoires intermédiaires — un rôle neuf n'a pas encore de roles/", async () => {
    const path = await writePromptFile(root, "roles/nouveau.md", "Bonjour.");
    expect(await readFile(path, "utf8")).toBe("Bonjour.");
  });

  it("ne laisse aucun fichier temporaire derrière elle", async () => {
    await writePromptFile(root, "roles/x.md", "un");
    await writePromptFile(root, "roles/x.md", "deux");
    const entries = await readdir(join(root, ".orch", "roles"));
    expect(entries).toEqual(["x.md"]);
  });

  it("ce qu'on écrit est exactement ce que le moteur relira", async () => {
    // La propriété qui compte, et la raison d'être de `rolePromptPath` : si
    // l'éditeur et `resolveRole` ne visaient pas le même fichier, le prompt
    // édité ne serait pas celui transmis à l'agent, sans que rien ne le dise.
    await saveLayer("project", root, {
      roles: [
        {
          name: "reviewer",
          purpose: "Relit.",
          agents: ["codex"],
          mode: "read-only",
          isolation: "auto",
          network: "auto",
          timeout_ms: 600_000,
          system_prompt_file: "roles/reviewer.md",
        },
      ],
    });
    await writePromptFile(root, "roles/reviewer.md", "Ne corrige rien toi-même.");

    const { config } = await loadConfig(root);
    const resolved = await resolveRole(config, root, "reviewer");
    expect(resolved?.systemPrompt).toBe("Ne corrige rien toi-même.");
  });
});

describe("validation du chemin", () => {
  it("accepte un chemin relatif", () => {
    expect(validatePromptFile("roles/reviewer.md")).toBeNull();
  });

  it("refuse un chemin vide", () => {
    expect(validatePromptFile("  ")).toMatch(/ne peut pas être vide/);
  });

  it("refuse un chemin absolu, qui deviendrait silencieusement relatif", () => {
    // `join(root, ".orch", "/etc/prompt.md")` rend `<root>/.orch/etc/prompt.md` :
    // on croit désigner un fichier du système, on en crée un autre.
    expect(validatePromptFile("/etc/prompt.md")).toMatch(/absolu/);
  });

  it('refuse un ".." qui sortirait du répertoire de configuration', () => {
    expect(validatePromptFile("../../ailleurs.md")).toMatch(/\.\./);
  });
});

describe("chemin par défaut", () => {
  it("suit la convention qu'écrit déjà « orch init »", () => {
    expect(defaultPromptFileFor("investigator")).toBe("roles/investigator.md");
  });
});
