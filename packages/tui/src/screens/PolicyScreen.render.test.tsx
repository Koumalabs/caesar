import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { defaultConfig } from "@orch/core";
import type { ConfigState } from "../state/config-state";
import { PolicyScreen } from "./PolicyScreen";

function makeState(): ConfigState {
  const config = defaultConfig();
  return { saved: config, draft: config, sources: {} };
}

describe("PolicyScreen", () => {
  it("se monte sans lever, affiche les champs de la politique et le rappel denied/allowed", async () => {
    const state = makeState();
    const setup = await act(async () =>
      testRender(<PolicyScreen state={state} onChange={() => {}} onEditingChange={() => {}} notify={() => {}} />, {
        width: 100,
        height: 30,
      }),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("max_parallel");
    expect(frame).toContain("denied");
    expect(frame).toContain("l'emporte toujours sur");
    setup.renderer.destroy();
  });
});
