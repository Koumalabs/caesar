/**
 * Analyse d'une ligne de sortie CLI, commune aux cinq adaptateurs : chacun
 * reçoit un flux de lignes potentiellement vides, mal formées ou hors-JSON
 * (bannières, avertissements, progression non structurée), et doit s'en
 * accommoder sans jamais lever. Un futur correctif sur cette analyse (BOM,
 * `\r\n`, etc.) se fait ici une seule fois plutôt que cinq fois à l'identique.
 */

/** Parse une ligne JSON ; renvoie `undefined` si elle est vide ou invalide. */
export function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Vrai pour un objet JSON simple (ni tableau, ni null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
