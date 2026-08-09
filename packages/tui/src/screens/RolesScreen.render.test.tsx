import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { defaultConfig } from "@orch/core";
import type { ConfigState } from "../state/config-state";
import { RolesScreen } from "./RolesScreen";

function makeState(): ConfigState {
  const config = defaultConfig();
  return { saved: config, draft: config, sources: {} };
}

describe("RolesScreen", () => {
  it("se monte sans lever et affiche les rôles par défaut", async () => {
    const state = makeState();
    const setup = await act(async () =>
      testRender(
        <RolesScreen state={state} installed={null} onChange={() => {}} onEditingChange={() => {}} notify={() => {}} />,
        { width: 100, height: 30 },
      ),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("reviewer");
    expect(frame).toContain("implementer");
    expect(frame).toContain("Agents (ordre de repli)");
    setup.renderer.destroy();
  });
});
