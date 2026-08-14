/**
 * La discipline d'affichage, éprouvée commande par commande.
 *
 * Les trois canaux décrits par `../output.ts` ne valent que s'ils tiennent
 * partout : il suffit d'un `sectionHeader` posé avant la branche `--json`
 * pour qu'une sortie machine devienne inexploitable, et rien dans le type ne
 * l'empêche. Ces tests sont ce garde-fou.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgentsList } from "./agents.js";
import { runDoctor } from "./doctor.js";
import { runGc } from "./gc.js";
import { runPolicyShow } from "./policy.js";
import { runRoleList } from "./role.js";
import { runPs } from "./tasks.js";
import { EXIT_OK } from "../output.js";
import { makeIo, withFakeHome, type CapturedIo } from "../../test/support.js";

type Commande = (root: string, options: { json?: boolean }, io: CapturedIo) => Promise<number>;

/** Les commandes qui rendent une vue à un humain, et dont `--json` est le pendant machine. */
const COMMANDES: ReadonlyArray<{ nom: string; libellé: string; run: Commande }> = [
  { nom: "doctor", libellé: "doctor", run: (root, o, io) => runDoctor(root, o, io) },
  { nom: "agents list", libellé: "agents", run: (root, o, io) => runAgentsList(root, o, io) },
  { nom: "policy show", libellé: "policy", run: (root, o, io) => runPolicyShow(root, o, io) },
  { nom: "role list", libellé: "role", run: (root, o, io) => runRoleList(root, o, io) },
  { nom: "ps", libellé: "ps", run: (root, o, io) => runPs(root, o, io) },
  { nom: "gc", libellé: "gc", run: (root, o, io) => runGc(root, o, io) },
];

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "caesar-theme-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("le thème, sur chaque commande", () => {
  for (const { nom, libellé, run } of COMMANDES) {
    it(`${nom} ouvre sur son bandeau`, async () => {
      await withFakeHome(async () => {
        const io = makeIo();
        expect(await run(root, {}, io)).toBe(EXIT_OK);
        expect(io.stdoutText()).toMatch(new RegExp(`^▞▚ caesar · ${libellé} ─+\\n`));
      });
    });

    it(`${nom} --json ne porte ni bandeau, ni couleur, ni ligne parasite`, async () => {
      await withFakeHome(async () => {
        const io = makeIo();
        expect(await run(root, { json: true }, io)).toBe(EXIT_OK);
        const out = io.stdoutText();
        expect(out).not.toMatch(/\x1b\[/);
        expect(out).not.toContain("▞▚");
        // La preuve qui compte : la sortie se relit telle quelle.
        expect(() => JSON.parse(out)).not.toThrow();
      });
    });

    it(`${nom} n'écrit aucune séquence ANSI vers un flux qui n'est pas un terminal`, async () => {
      await withFakeHome(async () => {
        const io = makeIo();
        await run(root, {}, io);
        expect(io.stdoutText()).not.toMatch(/\x1b\[/);
      });
    });
  }
});
