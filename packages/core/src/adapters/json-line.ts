/**
 * Parsing of a CLI output line, shared by all five adapters: each one
 * receives a stream of lines that may be empty, malformed or non-JSON
 * (banners, warnings, unstructured progress), and must cope with them
 * without ever throwing. A future fix to this parsing (BOM, `\r\n`, etc.)
 * is made here once rather than five times identically.
 */

/** Parses a JSON line; returns `undefined` if it is empty or invalid. */
export function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** True for a plain JSON object (neither array nor null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
