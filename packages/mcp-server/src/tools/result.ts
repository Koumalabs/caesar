/**
 * Tool response construction: compact and structured (see the brief — the
 * content enters the calling agent's context, it must never be a raw
 * dump).
 *
 * `content` (text) carries the same JSON as `structuredContent`, for
 * clients that do not read the latter field yet.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Successful result: `data` must stay compact (see the brief: status, summary, changed files, findings, questions — the raw detail belongs to `caesar_logs`). */
export function jsonResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/**
 * Refusal or domain error (policy, unknown role or task…). `message` is
 * returned verbatim: a policy refusal carries the exact reason produced by
 * `@caesar/core`, never rephrased (see the brief).
 */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
