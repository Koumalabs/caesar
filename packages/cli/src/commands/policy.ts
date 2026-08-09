/**
 * `orch policy show|allow|deny`.
 *
 * `policy show` doit indiquer, pour chaque valeur, de quel fichier elle
 * vient (global, projet, ou défaut). `@orch/core` ne publie que le résultat
 * déjà fusionné (`loadConfig`) : ce module ne réimplémente pas la lecture du
 * TOML pour en retrouver la provenance — il compose trois appels à
 * `loadConfig`, la seule fonction habilitée à lire ces fichiers, avec un
 * `HOME` ou une racine de projet momentanément neutralisés pour isoler la
 * contribution de chaque couche. Voir `computeProvenance` ci-dessous.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchConfig, PolicyConfig } from "@orch/core";
import { defaultConfig, loadConfig, saveProjectConfig } from "@orch/core";
import type { Io } from "../output.js";
import { EXIT_OK, printJson, renderTable, writeLine } from "../output.js";

type Source = "global" | "project" | "default";

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const fakeHome = await mkdtemp(join(tmpdir(), "orch-cli-home-"));
  const previous = process.env["HOME"];
  process.env["HOME"] = fakeHome;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
    await rm(fakeHome, { recursive: true, force: true });
  }
}

/**
 * Provenance de chaque champ de la politique effective, calculée en
 * comparant trois fusions obtenues via `loadConfig` (jamais en relisant le
 * TOML nous-mêmes) : la fusion réelle, une fusion "projet seul" (`HOME`
 * neutralisé) et une fusion "global seul" (racine neutralisée). Un champ qui
 * diffère du défaut dans la fusion "projet seul" vient du projet ; sinon,
 * s'il diffère du défaut dans la fusion "global seul", il vient du global ;
 * sinon, il vient du défaut.
 *
 * Limite assumée : un fichier qui fixe explicitement un champ à sa valeur
 * par défaut est indiscernable d'un champ absent — inhérent à une
 * comparaison par valeur plutôt que par présence syntaxique.
 */
export async function computeProvenance(root: string): Promise<{ policy: PolicyConfig; provenance: Record<keyof PolicyConfig, Source> }> {
  const def = defaultConfig().policy;
  const { config: merged } = await loadConfig(root);

  const projectOnly = await withTempHome(async () => (await loadConfig(root)).config);

  const fakeRoot = await mkdtemp(join(tmpdir(), "orch-cli-root-"));
  let globalOnly: OrchConfig;
  try {
    globalOnly = (await loadConfig(fakeRoot)).config;
  } finally {
    await rm(fakeRoot, { recursive: true, force: true });
  }

  const provenance = {} as Record<keyof PolicyConfig, Source>;
  for (const key of Object.keys(def) as (keyof PolicyConfig)[]) {
    if (!sameValue(projectOnly.policy[key], def[key])) provenance[key] = "project";
    else if (!sameValue(globalOnly.policy[key], def[key])) provenance[key] = "global";
    else provenance[key] = "default";
  }

  return { policy: merged.policy, provenance };
}

export interface PolicyShowOptions {
  json?: boolean;
}

export async function runPolicyShow(root: string, options: PolicyShowOptions, io: Io): Promise<number> {
  const { config, sources } = await loadConfig(root);
  const { provenance } = await computeProvenance(root);

  if (options.json) {
    printJson(io, { policy: config.policy, provenance, sources });
    return EXIT_OK;
  }

  const rows = (Object.keys(config.policy) as (keyof PolicyConfig)[]).map((key) => [
    key,
    JSON.stringify(config.policy[key]),
    provenance[key],
  ]);
  writeLine(io.stdout, renderTable(["champ", "valeur", "provenance"], rows));
  return EXIT_OK;
}

async function setPolicyList(root: string, id: string, list: "allowed" | "denied", present: boolean): Promise<OrchConfig> {
  const { config } = await loadConfig(root);
  const set = new Set(config.policy[list]);
  if (present) set.add(id);
  else set.delete(id);
  const updated: OrchConfig = { ...config, policy: { ...config.policy, [list]: [...set] } };
  await saveProjectConfig(root, updated);
  return updated;
}

export interface PolicyEditOptions {
  json?: boolean;
}

export async function runPolicyAllow(root: string, id: string, options: PolicyEditOptions, io: Io): Promise<number> {
  const config = await setPolicyList(root, id, "allowed", true);
  if (options.json) printJson(io, { id, allowed: config.policy.allowed });
  else writeLine(io.stdout, `Agent "${id}" ajouté à la liste "allowed".`);
  return EXIT_OK;
}

export async function runPolicyDeny(root: string, id: string, options: PolicyEditOptions, io: Io): Promise<number> {
  const config = await setPolicyList(root, id, "denied", true);
  if (options.json) printJson(io, { id, denied: config.policy.denied });
  else writeLine(io.stdout, `Agent "${id}" ajouté à la liste "denied".`);
  return EXIT_OK;
}
