/**
 * Utilitaires partagés par les tests du CLI.
 *
 * Deux garde-fous du brief de la tâche 6 à respecter systématiquement :
 * aucun test ne doit toucher le `~/.config/caesar/` réel, et aucun ne doit
 * invoquer un vrai CLI d'agent. `withFakeHome` isole le premier ;
 * `withShimmedPath` permet le second en substituant, sur un `PATH`
 * entièrement maîtrisé, un script factice au binaire d'un agent du
 * catalogue — le moteur (registre, adaptateur réel, contrat d'environnement)
 * tourne alors pour de vrai, seul le processus externe est un agent
 * factice.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Io } from "../src/output.js";

export interface CapturedIo extends Io {
  stdoutText(): string;
  stderrText(): string;
}

/** Un `Io` dont les flux sont capturés en mémoire plutôt qu'écrits sur le terminal — jamais de `isTTY`, donc jamais de couleur. */
export function makeIo(): CapturedIo {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(chunk.toString());
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stdout,
    stderr,
    stdoutText: () => stdoutChunks.join(""),
    stderrText: () => stderrChunks.join(""),
  };
}

/**
 * Exécute `fn` avec `HOME` pointé vers un répertoire temporaire fraîchement
 * créé, garantissant qu'aucun `~/.config/caesar/config.toml` réel n'est lu ni
 * écrit — même motif que `packages/core/src/config.test.ts`.
 */
export async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "caesar-cli-home-"));
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

/**
 * Exécute `fn` avec un `PATH` entièrement remplacé par `shimDir` plus les
 * répertoires strictement nécessaires à la résolution de `/usr/bin/env` (les
 * scripts factices utilisent tous ce shebang) et de `node` lui-même. Résultat :
 * seuls les binaires explicitement déposés dans `shimDir` sont "installés" —
 * aucun agent réellement présent sur la machine ne peut fausser le test.
 */
export async function withShimmedPath<T>(shimDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env["PATH"];
  const minimal = [shimDir, "/usr/bin", "/bin", dirname(process.execPath)].join(delimiter);
  process.env["PATH"] = minimal;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
}

/**
 * Écrit, sous `dir/bin`, un redirecteur d'une ligne vers `sourcePath` plutôt
 * qu'une copie de son contenu : une copie casserait la résolution de module
 * de tout import que le script ferait lui-même (le mode "ask" de l'agent
 * factice, tâche 9, importe dynamiquement `@modelcontextprotocol/sdk` — une
 * copie déposée dans ce répertoire de shim temporaire, sans rapport avec le
 * monorepo, ne le résoudrait pas). Même correction que `packages/mcp-server/test/support.ts` (tâche 10, A4).
 */
async function shimFrom(dir: string, bin: string, sourcePath: string): Promise<void> {
  const target = join(dir, bin);
  const redirect = `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(sourcePath).href)});\n`;
  await writeFile(target, redirect, "utf8");
  await chmod(target, 0o755);
}

/** Chemin de l'agent factice partagé par `@caesar/core` (voir son brief : réutilisé tel quel, jamais dupliqué). */
export const FAKE_AGENT_PATH = fileURLToPath(new URL("../../core/test/fixtures/fake-agent.mjs", import.meta.url));

/**
 * Crée un répertoire de shim temporaire où `bin` (p. ex. "codex") est en
 * réalité une copie de l'agent factice de `@caesar/core`. Le vrai adaptateur du
 * registre construit ses arguments spécifiques (flags Codex, etc.), mais le
 * script factice les ignore et ne regarde que les variables d'environnement
 * du contrat minimal ($CAESAR_TASK_FILE, $CAESAR_REPORT_PATH…) — un aller-retour
 * complet et réaliste, sans jamais toucher au vrai binaire de l'agent.
 */
export async function withFakeAgentAsBin<T>(bin: string, fn: (shimDir: string) => Promise<T>): Promise<T> {
  const shimDir = await mkdtemp(join(tmpdir(), "caesar-cli-shim-"));
  try {
    await shimFrom(shimDir, bin, FAKE_AGENT_PATH);
    return await withShimmedPath(shimDir, () => fn(shimDir));
  } finally {
    await rm(shimDir, { recursive: true, force: true });
  }
}

/**
 * Pose `allow_inplace_write = true` dans la couche projet de `root`.
 *
 * Une tâche en écriture demandant explicitement `isolation = "inplace"` dans un
 * dépôt git utilisable est refusée par défaut (voir `decideInplaceWrite`,
 * `@caesar/core`) : c'est la correction du défaut qui laissait des délégations
 * écrire sur la branche de travail de l'utilisateur en silence. Les tests qui
 * exercent *autre chose* que cette règle — un aller-retour complet, un timeout,
 * un code de sortie — n'ont pas à la subir, mais ils doivent l'assumer
 * explicitement, exactement comme un utilisateur le ferait.
 *
 * Insère la clé dans un `[policy]` existant plutôt que d'écraser le fichier :
 * plusieurs tests écrivent déjà leur propre couche projet (`[[agent]]`, …), et
 * deux tables `[policy]` dans un même TOML seraient une erreur de parsing.
 */
export async function allowInplaceWrite(root: string): Promise<void> {
  const path = join(root, ".caesar", "config.toml");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // Aucune couche projet : on en crée une.
  }
  const line = "allow_inplace_write = true\n";
  const next = existing.includes("[policy]")
    ? existing.replace("[policy]\n", `[policy]\n${line}`)
    : `[policy]\n${line}\n${existing}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
}

/** Dépose un script minimal répondant `--version` avec succès, pour les tests de `caesar doctor`. */
export async function writeVersionOkShim(dir: string, bin: string, version: string): Promise<void> {
  const target = join(dir, bin);
  await writeFile(
    target,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(version)} + "\\n");\nprocess.exit(0);\n`,
    "utf8",
  );
  await chmod(target, 0o755);
}

/** Dépose un script minimal qui échoue systématiquement (y compris sur --version), pour les tests de `caesar doctor`. */
export async function writeVersionFailShim(dir: string, bin: string): Promise<void> {
  const target = join(dir, bin);
  await writeFile(target, `#!/usr/bin/env node\nprocess.exit(1);\n`, "utf8");
  await chmod(target, 0o755);
}
