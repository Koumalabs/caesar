/**
 * Transport-level test (the sole exception to the brief: "the server is
 * tested by calling the tool functions directly, without going through a
 * transport, except where the transport itself is at stake"): nothing but
 * the JSON-RPC protocol may appear on the stdio transport's output stream —
 * the classic mistake that breaks this kind of server in obscure ways.
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

describe("buildServer over the stdio transport", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-server-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lets nothing but JSON-RPC travel on the output stream", async () => {
    const { server } = await buildServer(root);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout);
    await server.connect(transport);

    const initRequest = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
    const responsePromise = nextLine(stdout);
    stdin.write(JSON.stringify(initRequest) + "\n");
    const initResponseLine = await responsePromise;

    // Every line on the stream must be valid JSON-RPC — no diagnostic
    // message, no `console.log`, nothing else slips in.
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
      "caesar_answer",
      "caesar_apply",
      "caesar_await",
      "caesar_cancel",
      "caesar_delegate",
      "caesar_diff",
      "caesar_list_agents",
      "caesar_list_roles",
      "caesar_logs",
      "caesar_status",
    ]);

    // A real tool call, through the protocol: proof that each tool's zod 4
    // schema (including `caesar_status`, which takes an argument) is
    // actually converted and validated on the SDK side, not merely built
    // without error (see the brief's watch point on the MCP SDK's zod
    // compatibility).
    const callRequest = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "caesar_status", arguments: { task_id: "t_nonexistent" } },
    };
    const callResponsePromise = nextLine(stdout);
    stdin.write(JSON.stringify(callRequest) + "\n");
    const callResponseLine = await callResponsePromise;
    const callResponse = JSON.parse(callResponseLine) as { result: { isError?: boolean; content: Array<{ type: string; text: string }> } };
    expect(callResponse.result.isError).toBe(true);
    expect(callResponse.result.content[0]?.text).toMatch(/unknown task/i);

    await server.close();
    stdin.end();
  });
});
