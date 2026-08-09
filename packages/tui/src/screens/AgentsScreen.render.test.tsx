/**
 * Test de rendu minimal — "se monte sans lever" (voir le brief : un test de
 * montage par écran suffit, pas plus). `@opentui/core/testing` fournit un
 * renderer hors-terminal (`testRender`/`captureCharFrame`), sans dépendre
 * d'un vrai TTY.
 */
import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { defaultConfig } from "@orch/core";
import type { ConfigState } from "../state/config-state";
import { AgentsScreen } from "./AgentsScreen";

function makeState(): ConfigState {
  const config = defaultConfig();
  return { saved: config, draft: config, sources: {} };
}

describe("AgentsScreen", () => {
  it("se monte sans lever et affiche le catalogue d'agents", async () => {
    const state = makeState();
    const setup = await act(async () =>
      testRender(<AgentsScreen state={state} installed={null} onToggleDenied={() => {}} />, { width: 100, height: 30 }),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("codex");
    expect(frame).toContain("antigravity");
    expect(frame).toContain("Détection de l'installation en cours");
    setup.renderer.destroy();
  });
});
