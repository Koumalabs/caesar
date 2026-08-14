/**
 * `IntegrationsScreen` triggers `checkMcpStatus` on mount (one read per
 * client). For the file-based clients, that reads under `$HOME` — never
 * the user's real configuration in a test: `HOME` is neutralized the way
 * `packages/cli/test/support.ts` does it (`withFakeHome`). For
 * `claude`/`codex`, `checkMcpStatus` launches no subprocess (see
 * `packages/cli/src/commands/mcp.ts`), so no real agent CLI is invoked
 * here.
 *
 * This guarantee depends on `buildPlan` (`@caesar/core`,
 * `mcp-registration.ts`) resolving `$HOME` via `homeDirectory()`, not
 * `os.homedir()` directly: Bun (this package's runtime) silently ignores
 * `$HOME` in `os.homedir()`, which Node does not — this test therefore
 * neutralized `HOME` with no real effect under Bun as long as `buildPlan`
 * called a bare `homedir()`, for the `copilot`/`antigravity`/`opencode`
 * paths (review finding of task 15, fixed in `mcp-registration.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { IntegrationsScreen } from "./IntegrationsScreen";

let previousHome: string | undefined;
let home: string;
let root: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "caesar-tui-integrations-home-"));
  root = await mkdtemp(join(tmpdir(), "caesar-tui-integrations-root-"));
  previousHome = process.env["HOME"];
  process.env["HOME"] = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("IntegrationsScreen", () => {
  it("mounts without throwing and shows the five MCP clients", async () => {
    const setup = await act(async () => testRender(<IntegrationsScreen root={root} notify={() => {}} />, { width: 100, height: 20 }));
    await act(async () => setup.renderOnce());
    // Let the initial `checkMcpStatus` (async, one per client) resolve.
    await act(async () => {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 50));
      await setup.renderOnce();
    });
    const frame = setup.captureCharFrame();
    for (const client of ["claude", "codex", "copilot", "opencode", "antigravity"]) {
      expect(frame).toContain(client);
    }
    setup.renderer.destroy();
  });
});
