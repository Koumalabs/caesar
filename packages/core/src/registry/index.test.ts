import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGenericAgent } from "./generic.js";
import {
  AGENT_DEFINITIONS,
  describeAgentCapabilities,
  detectAgentInstallation,
  findAgentDefinition,
  findBinaryInPath,
  listAgentDefinitions,
  resolveAgentDefinition,
} from "./index.js";

describe("agent catalog", () => {
  it("exposes the five known agents", () => {
    const ids = listAgentDefinitions().map((agent) => agent.id);
    expect(ids).toEqual(["codex", "antigravity", "opencode", "copilot", "claude"]);
  });

  it("resolves an agent by identifier", () => {
    expect(resolveAgentDefinition("codex")).toBe(AGENT_DEFINITIONS[0]);
  });

  it("throws on an unknown identifier", () => {
    expect(() => resolveAgentDefinition("ghost-agent")).toThrow(/ghost-agent/);
  });

  it("findAgentDefinition returns undefined on an unknown identifier, without throwing", () => {
    expect(findAgentDefinition("ghost-agent")).toBeUndefined();
  });
});

describe("installation detection", () => {
  it("detects the absence of a binary from the PATH", async () => {
    const agent = createGenericAgent({ id: "ghost", bin: "this-binary-does-not-exist-xyz", args: [] });
    const status = await detectAgentInstallation(agent);
    expect(status).toEqual({ id: "ghost", bin: "this-binary-does-not-exist-xyz", installed: false });
  });

  it("detects a binary present in the PATH and picks up its version when it is cheap", async () => {
    // node is necessarily present: it is the runtime executing this test.
    const agent = createGenericAgent({ id: "node-runtime", bin: "node", args: [] });
    const status = await detectAgentInstallation(agent);
    expect(status.installed).toBe(true);
    expect(status.path).toBeTruthy();
    expect(status.version).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it("findBinaryInPath returns null for an absent binary", async () => {
    expect(await findBinaryInPath("this-binary-does-not-exist-xyz")).toBeNull();
  });

  it("findBinaryInPath returns a path for a present binary", async () => {
    expect(await findBinaryInPath("node")).toBeTruthy();
  });

  it("findBinaryInPath accepts an explicit path without looking it up in the PATH", async () => {
    // The `execvp` rule: a name containing a separator designates a file.
    // Without it, an agent declared by absolute path (`caesar agents add --bin
    // /opt/my-cli`) ran but was reported "absent" everywhere.
    const nodePath = process.execPath;
    expect(await findBinaryInPath(nodePath)).toBe(nodePath);
    expect(await findBinaryInPath("/opt/this-path-does-not-exist-xyz/bin")).toBeNull();
  });

  it("findBinaryInPath refuses a non-executable explicit path", async () => {
    // A file that exists but lacks the execute bit is not a launchable
    // binary: distinguishing it avoids a misleading "installed".
    expect(await findBinaryInPath(fileURLToPath(import.meta.url))).toBeNull();
  });
});

/**
 * Moved from `packages/cli/src/commands/agents.ts` (task 8, correction
 * report) — see its docstring for the reasoning. `packages/cli`
 * (`agents.ts`, `doctor.ts`) now calls it from here; its tests
 * keep passing without modification.
 */
describe("describeAgentCapabilities", () => {
  it("each notable capability produces its own label", () => {
    const agent = createGenericAgent({
      id: "full",
      bin: "full-cli",
      args: [],
      capabilities: {
        nativeReadOnly: true,
        outputSchema: true,
        finalMessageFile: true,
        resume: true,
        addDir: true,
        model: true,
        mcpInjection: "flag",
      },
    });
    expect(describeAgentCapabilities(agent)).toEqual([
      // First: always present, and the most decisive.
      "network unknown",
      "native read-only",
      "output schema",
      "final message file",
      "resume",
      "additional directories",
      "model choice",
      "mcp:flag",
    ]);
  });

  it("always names the network, including for an agent without any other capability", () => {
    const bare = createGenericAgent({ id: "bare", bin: "bare", args: [] });
    expect(describeAgentCapabilities(bare)).toEqual(["network unknown"]);
  });

  it("distinguishes the catalog agents by their network — the diagnostic that was missing", () => {
    const byAgent = new Map(
      listAgentDefinitions().map((def) => [def.id, def.capabilities.network] as const),
    );
    expect(byAgent.get("codex")).toBe("write-only");
    expect(byAgent.get("copilot")).toBe("toggle");
    expect(byAgent.get("claude")).toBe("open");
    expect(byAgent.get("antigravity")).toBe("open");
    expect(byAgent.get("opencode")).toBe("open");
  });

  it("every native catalog agent has at least one notable capability", () => {
    for (const def of listAgentDefinitions()) {
      expect(describeAgentCapabilities(def).length).toBeGreaterThan(0);
    }
  });
});
