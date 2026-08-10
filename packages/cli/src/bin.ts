#!/usr/bin/env node
/**
 * Point d'entrée Node du binaire `orch` (`package.json`, `"bin": { "orch":
 * "./dist/bin.js" }`) : ne fait que déléguer à `runCli` (`./program.js`) et
 * traduire son résultat en `process.exitCode`, derrière un garde
 * d'auto-invocation — voir `isMain` plus bas.
 *
 * Tout le câblage commander vit dans `./program.js`, volontairement séparé
 * de ce fichier (voir son en-tête pour la raison précise, tâche 12) : ce
 * fichier-ci ne doit jamais être importé par un autre point d'entrée — son
 * garde `isMain` suppose que `import.meta.url` reste propre à ce module,
 * une hypothèse vraie sous Node mais fausse dans un binaire compilé par Bun
 * (`bun-entry.ts`, qui importe `runCli` depuis `./program.js` directement,
 * jamais depuis ce fichier).
 */
import { fileURLToPath } from "node:url";
import { runCli } from "./program.js";

export { buildProgram, runCli } from "./program.js";

// Seuil d'exécution directe : ce module se comporte en bibliothèque quand il
// est importé (par les tests, notamment), et en exécutable seulement quand
// il est lancé en tant que tel.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const code = await runCli(process.argv);
  process.exitCode = code;
}
