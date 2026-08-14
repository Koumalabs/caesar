/**
 * Verifies, under the real **Bun** runtime — the only one where the defect
 * manifests (see `packages/core/src/config.ts`, `homeDirectory`) — that
 * `checkMcpStatus`/`buildPlan` (`@caesar/core`, `mcp-registration.ts`)
 * really read under this test's neutralized `$HOME`, never under the
 * machine's real home directory.
 *
 * A test that compares two paths both *computed* in the test
 * (`buildPlan(...).path === join(homeDirectory(), ...)`,
 * `packages/core/src/mcp-registration.test.ts`) cannot detect a regression
 * to a bare `os.homedir()`: both expressions produce the same value,
 * whether the implementation is correct or regressed — finding from the
 * review of task 15, which established this by executing it, not by
 * reading it. `IntegrationsScreen.render.test.tsx` does not detect it
 * either: its assertion covers the five client names, rendered from a
 * static list independent of `checkMcpStatus`'s result.
 *
 * This test proceeds by **observation** rather than by comparison: a
 * client configuration file is written under the neutralized `$HOME`, and
 * `checkMcpStatus` must then find it *at that precise location*. If the
 * code fell back to `os.homedir()` (which, under Bun, ignores `$HOME`), it
 * would look in the machine's real home directory, would not find this
 * file there (written only under the neutralized `$HOME`), and would
 * return "not-registered" instead of "registered" — the assertion would
 * fail. Verified by the inverse experiment before committing (see the
 * correction report of task 15): this test does fail if
 * `mcp-registration.ts` goes back to a bare `homedir()`, and passes once
 * the fix is put back in place.
 *
 * `root` (project root passed to `buildPlan`/`checkMcpStatus`) is distinct
 * from `home`: neither needs to contain the other for this test, which
 * concerns only home-directory resolution.
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

/** The three file-based clients affected by the defect (see the correction report) — `claude`/`codex` are subcommands, out of scope here. */
const FILE_CLIENTS = [
  { client: "copilot" as const, relDir: [".copilot"], file: "mcp-config.json", mergeKey: "mcpServers" },
  { client: "antigravity" as const, relDir: [".gemini", "antigravity-cli"], file: "settings.json", mergeKey: "mcpServers" },
  { client: "opencode" as const, relDir: [".config", "opencode"], file: "opencode.json", mergeKey: "mcp" },
];

describe("mcp-registration (@caesar/core) under Bun: reads under the neutralized $HOME, not under the real home directory", () => {
  for (const { client, relDir, file, mergeKey } of FILE_CLIENTS) {
    it(`${client}: checkMcpStatus finds a file written under this test's neutralized $HOME`, async () => {
      const dir = join(home, ...relDir);
      const path = join(dir, file);
      await mkdir(dir, { recursive: true });
      await writeFile(path, JSON.stringify({ [mergeKey]: { caesar: { command: "caesar" } } }), "utf8");

      const status = await checkMcpStatus(client, root);
      expect(status.registered).toBe("registered");
      // The message names the path that was read: it must point under `home` (this test's neutralized
      // `$HOME`), never under the real home directory of the machine running these tests.
      expect(status.detail).toContain(home);

      const plan = buildPlan(client, root);
      expect(plan.kind === "file" && plan.path).toBe(path);
    });

    it(`${client}: "not-registered" as long as nothing is written under the neutralized $HOME (not a false "registered" from the real directory)`, async () => {
      const status = await checkMcpStatus(client, root);
      expect(status.registered).toBe("not-registered");
      expect(status.detail).toContain(home);
    });
  }
});
