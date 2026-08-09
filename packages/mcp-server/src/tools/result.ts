/**
 * Construction des réponses de tool : compactes et structurées (voir le
 * brief — le contenu entre dans le contexte de l'agent appelant, il ne doit
 * jamais être un déversement brut).
 *
 * `content` (texte) porte le même JSON que `structuredContent`, pour les
 * clients qui ne lisent pas encore ce dernier champ.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Résultat réussi : `data` doit rester compact (voir le brief : statut, résumé, fichiers modifiés, constats, questions — le détail brut relève d'`orch_logs`). */
export function jsonResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/**
 * Refus ou erreur métier (politique, rôle ou tâche inconnus…). `message` est
 * rendu tel quel : un refus de politique porte le motif exact rendu par
 * `@orch/core`, jamais reformulé (voir le brief).
 */
export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
