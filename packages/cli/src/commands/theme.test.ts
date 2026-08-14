/**
 * The display discipline, exercised command by command.
 *
 * The three channels described by `../output.ts` are only worth anything if
 * they hold everywhere: one `sectionHeader` placed before the `--json`
 * branch is enough to make machine output unusable, and nothing in the type
 * prevents it. These tests are that guardrail.
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

type Command = (root: string, options: { json?: boolean }, io: CapturedIo) => Promise<number>;

/** The commands that render a view to a human, and whose `--json` is the machine counterpart. */
const COMMANDS: ReadonlyArray<{ name: string; label: string; run: Command }> = [
  { name: "doctor", label: "doctor", run: (root, o, io) => runDoctor(root, o, io) },
  { name: "agents list", label: "agents", run: (root, o, io) => runAgentsList(root, o, io) },
  { name: "policy show", label: "policy", run: (root, o, io) => runPolicyShow(root, o, io) },
  { name: "role list", label: "role", run: (root, o, io) => runRoleList(root, o, io) },
  { name: "ps", label: "ps", run: (root, o, io) => runPs(root, o, io) },
  { name: "gc", label: "gc", run: (root, o, io) => runGc(root, o, io) },
];

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "caesar-theme-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the theme, on each command", () => {
  for (const { name, label, run } of COMMANDS) {
    it(`${name} opens on its banner`, async () => {
      await withFakeHome(async () => {
        const io = makeIo();
        expect(await run(root, {}, io)).toBe(EXIT_OK);
        expect(io.stdoutText()).toMatch(new RegExp(`^▞▚ caesar · ${label} ─+\\n`));
      });
    });

    it(`${name} --json carries neither banner, nor color, nor stray line`, async () => {
      await withFakeHome(async () => {
        const io = makeIo();
        expect(await run(root, { json: true }, io)).toBe(EXIT_OK);
        const out = io.stdoutText();
        expect(out).not.toMatch(/\x1b\[/);
        expect(out).not.toContain("▞▚");
        // The proof that matters: the output re-reads as-is.
        expect(() => JSON.parse(out)).not.toThrow();
      });
    });

    it(`${name} writes no ANSI sequence to a stream that is not a terminal`, async () => {
      await withFakeHome(async () => {
        const io = makeIo();
        await run(root, {}, io);
        expect(io.stdoutText()).not.toMatch(/\x1b\[/);
      });
    });
  }
});
