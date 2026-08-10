/**
 * `orch channel serve --task-dir <dir>` — la sous-commande interne du canal
 * retour (tâche 12). Même style de test que `mcp.test.ts` pour `orch mcp
 * serve` : un vrai échange JSON-RPC sur un flux stdio simulé, pas un appel
 * direct à `buildChannelServer` (déjà couvert par
 * `packages/mcp-channel/src/server.test.ts`) — ce test vérifie la façade
 * `runChannelServe` elle-même, celle que `bin.ts`/`bun-entry.ts` invoquent.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK_PROTOCOL, TaskSchema, taskPaths, writeTask } from "@orch/protocol";
import { runChannelServe } from "./channel.js";
import { EXIT_OK } from "../output.js";

describe("orch channel serve", () => {
  let taskDir: string;

  beforeEach(async () => {
    taskDir = await mkdtemp(join(tmpdir(), "orch-cli-channel-serve-"));
    const task = TaskSchema.parse({
      protocol: TASK_PROTOCOL,
      id: "t_channel_cli",
      created_at: new Date().toISOString(),
      agent: "codex",
      objective: "Vérifier le canal depuis la sous-commande CLI",
      mode: "write",
      isolation: "inplace",
      workspace: taskDir,
      deadline_ms: 600_000,
      report_path: join(taskDir, "report.json"),
      events_path: join(taskDir, "events.jsonl"),
    });
    await writeTask(taskPaths(taskDir), task);
  });

  afterEach(async () => {
    await rm(taskDir, { recursive: true, force: true });
  });

  it("répond à un échange JSON-RPC réel : initialize puis l'appel de get_task", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let stdoutBytes = "";
    stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.toString("utf8");
    });

    const code = await runChannelServe(taskDir, { stdin, stdout });
    expect(code).toBe(EXIT_OK);

    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }) + "\n",
    );
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_task", arguments: {} } }) + "\n");
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 100));

    const lines = stdoutBytes.split("\n").filter((l) => l.trim() !== "");
    const parsed = lines.map((line) => JSON.parse(line) as { id?: number; result?: { structuredContent?: { objective?: string } } });
    const getTaskResponse = parsed.find((message) => message.id === 2);
    expect(getTaskResponse?.result?.structuredContent?.objective).toBe("Vérifier le canal depuis la sous-commande CLI");

    stdin.end();
  });
});
