/**
 * `IntegrationsScreen` déclenche `checkMcpStatus` au montage (une lecture
 * par client). Pour les clients à fichier, cela lit sous `$HOME` — jamais la
 * configuration réelle de l'utilisateur dans un test : `HOME` est neutralisé
 * comme le fait `packages/cli/test/support.ts` (`withFakeHome`). Pour
 * `claude`/`codex`, `checkMcpStatus` ne lance aucun sous-processus (voir
 * `packages/cli/src/commands/mcp.ts`), donc aucun vrai CLI d'agent n'est
 * invoqué ici.
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
  home = await mkdtemp(join(tmpdir(), "orch-tui-integrations-home-"));
  root = await mkdtemp(join(tmpdir(), "orch-tui-integrations-root-"));
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
  it("se monte sans lever et affiche les cinq clients MCP", async () => {
    const setup = await act(async () => testRender(<IntegrationsScreen root={root} notify={() => {}} />, { width: 100, height: 20 }));
    await act(async () => setup.renderOnce());
    // Laisse le `checkMcpStatus` initial (async, un par client) se résoudre.
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
