/**
 * Test au niveau du transport (la seule exception au brief : « le serveur se
 * teste en appelant les fonctions de tool directement, sans passer par un
 * transport, sauf là où le transport lui-même est en jeu ») : rien d'autre
 * que le protocole JSON-RPC ne doit apparaître sur le flux de sortie du
 * transport stdio — l'erreur classique qui casse ce genre de serveur de
 * façon obscure.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

function nextLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        stream.off("data", onData);
        resolve(buffer.slice(0, newline));
      }
    };
    stream.on("data", onData);
  });
}

describe("buildServer sur le transport stdio", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-server-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ne laisse rien d'autre que du JSON-RPC transiter sur le flux de sortie", async () => {
    const { server } = buildServer(root);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout);
    await server.connect(transport);

    const initRequest = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
    const responsePromise = nextLine(stdout);
    stdin.write(JSON.stringify(initRequest) + "\n");
    const initResponseLine = await responsePromise;

    // Chaque ligne du flux doit être un JSON-RPC valide — aucun message de
    // diagnostic, aucun `console.log`, rien d'autre ne s'y glisse.
    expect(() => JSON.parse(initResponseLine)).not.toThrow();
    const initResponse = JSON.parse(initResponseLine) as { jsonrpc: string; id: number; result: unknown };
    expect(initResponse.jsonrpc).toBe("2.0");
    expect(initResponse.id).toBe(1);

    const listRequest = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    const listResponsePromise = nextLine(stdout);
    stdin.write(JSON.stringify(listRequest) + "\n");
    const listResponseLine = await listResponsePromise;

    const listResponse = JSON.parse(listResponseLine) as { result: { tools: Array<{ name: string }> } };
    const names = listResponse.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "orch_apply",
      "orch_await",
      "orch_cancel",
      "orch_delegate",
      "orch_diff",
      "orch_list_agents",
      "orch_list_roles",
      "orch_logs",
      "orch_status",
    ]);

    // Un appel de tool réel, à travers le protocole : preuve que le schéma
    // zod 4 de chaque tool (dont `orch_status`, qui prend un argument) est
    // effectivement converti et validé côté SDK, pas seulement construit
    // sans erreur (voir le point de vigilance du brief sur la compatibilité
    // zod du SDK MCP).
    const callRequest = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "orch_status", arguments: { task_id: "t_inexistant" } },
    };
    const callResponsePromise = nextLine(stdout);
    stdin.write(JSON.stringify(callRequest) + "\n");
    const callResponseLine = await callResponsePromise;
    const callResponse = JSON.parse(callResponseLine) as { result: { isError?: boolean; content: Array<{ type: string; text: string }> } };
    expect(callResponse.result.isError).toBe(true);
    expect(callResponse.result.content[0]?.text).toMatch(/inconnue/);

    await server.close();
    stdin.end();
  });
});
