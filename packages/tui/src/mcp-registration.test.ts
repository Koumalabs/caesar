/**
 * Vérifie, sous le vrai runtime **Bun** — le seul où le défaut se manifeste
 * (voir `packages/core/src/config.ts`, `homeDirectory`) — que
 * `checkMcpStatus`/`buildPlan` (`@caesar/core`, `mcp-registration.ts`) lisent
 * effectivement sous le `$HOME` neutralisé de ce test, jamais sous le vrai
 * répertoire personnel de la machine.
 *
 * Un test qui compare deux chemins tous deux *calculés* dans le test
 * (`buildPlan(...).path === join(homeDirectory(), ...)`,
 * `packages/core/src/mcp-registration.test.ts`) ne peut pas détecter une
 * régression vers `os.homedir()` en clair : les deux expressions produisent
 * la même valeur, que l'implémentation soit correcte ou régressée — constat
 * de la revue de la tâche 15, qui a établi ce point en l'exécutant, pas en
 * le lisant. `IntegrationsScreen.render.test.tsx` ne le détecte pas non
 * plus : son assertion porte sur les cinq noms de clients, rendus depuis une
 * liste statique indépendante du résultat de `checkMcpStatus`.
 *
 * Ce test-ci procède par **constat** plutôt que par comparaison : un fichier
 * de configuration client est écrit sous le `$HOME` neutralisé, puis
 * `checkMcpStatus` doit le trouver *à cet endroit précis*. Si le code
 * retombait sur `os.homedir()` (qui, sous Bun, ignore `$HOME`), il
 * chercherait dans le vrai répertoire personnel de la machine, n'y
 * trouverait pas ce fichier (écrit uniquement sous le `$HOME` neutralisé),
 * et rendrait "not-registered" au lieu de "registered" — l'assertion
 * tomberait. Vérifié par l'épreuve inverse avant de committer (voir le
 * rapport de correction de la tâche 15) : ce test échoue bien si
 * `mcp-registration.ts` revient à `homedir()` en clair, et passe une fois le
 * correctif remis en place.
 *
 * `root` (racine du projet passée à `buildPlan`/`checkMcpStatus`) est
 * distinct de `home` : aucun des deux n'a besoin de contenir l'autre pour ce
 * test, qui porte uniquement sur la résolution du répertoire personnel.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, checkMcpStatus } from "@caesar/core";

let home: string;
let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "caesar-tui-mcp-home-"));
  root = await mkdtemp(join(tmpdir(), "caesar-tui-mcp-root-"));
  previousHome = process.env["HOME"];
  process.env["HOME"] = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

/** Les trois clients à fichier concernés par le défaut (voir le rapport de correction) — `claude`/`codex` sont des sous-commandes, hors de propos ici. */
const FILE_CLIENTS = [
  { client: "copilot" as const, relDir: [".copilot"], file: "mcp-config.json", mergeKey: "mcpServers" },
  { client: "antigravity" as const, relDir: [".gemini", "antigravity-cli"], file: "settings.json", mergeKey: "mcpServers" },
  { client: "opencode" as const, relDir: [".config", "opencode"], file: "opencode.json", mergeKey: "mcp" },
];

describe("mcp-registration (@caesar/core) sous Bun : lit sous $HOME neutralisé, pas sous le vrai répertoire personnel", () => {
  for (const { client, relDir, file, mergeKey } of FILE_CLIENTS) {
    it(`${client} : checkMcpStatus trouve un fichier écrit sous le $HOME neutralisé de ce test`, async () => {
      const dir = join(home, ...relDir);
      const path = join(dir, file);
      await mkdir(dir, { recursive: true });
      await writeFile(path, JSON.stringify({ [mergeKey]: { caesar: { command: "caesar" } } }), "utf8");

      const status = await checkMcpStatus(client, root);
      expect(status.registered).toBe("registered");
      // Le message nomme le chemin lu : il doit pointer sous `home` (le `$HOME` neutralisé de ce test), jamais
      // sous le vrai répertoire personnel de la machine qui exécute ces tests.
      expect(status.detail).toContain(home);

      const plan = buildPlan(client, root);
      expect(plan.kind === "file" && plan.path).toBe(path);
    });

    it(`${client} : "not-registered" tant que rien n'est écrit sous le $HOME neutralisé (pas un faux "registered" venu du vrai répertoire)`, async () => {
      const status = await checkMcpStatus(client, root);
      expect(status.registered).toBe("not-registered");
      expect(status.detail).toContain(home);
    });
  }
});
