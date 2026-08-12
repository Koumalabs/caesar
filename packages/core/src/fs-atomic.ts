/**
 * Écriture atomique de fichiers texte : motif tmp+`rename` répété tel quel
 * dans `store.ts`, `config.ts` (`saveLayer`) et `mcp-registration.ts`
 * (`writeJsonFileAtomic`) avant cette extraction — un seul endroit pour le
 * définir puisque le chantier suivant (dépôt de skills/commandes chez les
 * runtimes d'agents) en aura de nouveau besoin.
 *
 * Le temporaire vit dans le même répertoire que la cible — condition
 * nécessaire pour que `rename` soit atomique juste après (même système de
 * fichiers) — et porte un nom caché (`.` en tête) sans extension `.md` : un
 * scan récursif des fichiers Markdown du dépôt ne le ramasse donc jamais
 * entre l'écriture du temporaire et le `rename`.
 *
 * `store.ts` garde son propre motif (`writeTemp` partagé, puis `rename` ou
 * `link` selon l'opération) : sa sémantique de remplacement conditionnel via
 * `link` (voir son en-tête) sort du périmètre de ce helper, volontairement
 * limité au cas `rename` inconditionnel.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Écrit `content` dans `path` de façon atomique : un lecteur concurrent ne
 * voit jamais qu'une version complète du fichier (l'ancienne ou la
 * nouvelle), jamais un contenu partiel ou tronqué si le processus est
 * interrompu en cours d'écriture. Crée le répertoire parent au besoin
 * (`mkdir` récursif), pour que l'appelant n'ait pas à s'en assurer avant.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}
