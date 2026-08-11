/**
 * Éditeur plein écran du prompt système d'un rôle — le texte que
 * `resolveRole` place en tête du contexte transmis à l'agent
 * (`delegation.ts`). C'est *le* prompt de l'agent pour ce rôle : jusqu'ici le
 * TUI n'en montrait que le chemin, et il fallait sortir de l'outil pour en
 * changer un mot.
 *
 * Deux choses le distinguent du reste du TUI, et l'écran les dit toutes deux
 * plutôt que de les laisser surprendre :
 *
 *  - **il écrit tout de suite.** Ctrl+S enregistre le fichier, sans passer
 *    par le "s" global ni par la portée d'édition : un prompt est un fichier
 *    unique, pas un réglage à trois couches (voir `prompt-file.ts`).
 *  - **il désigne le fichier que le moteur lira**, chemin absolu affiché en
 *    tête, calculé par `rolePromptPath` (`@orch/core`) — celui-là même
 *    qu'ouvre `resolveRole`. Un rôle venu de la couche globale résout son
 *    prompt dans le projet courant : le chemin le montre, plutôt que de
 *    laisser croire à un fichier partagé entre projets.
 *
 * Échap abandonne, et demande confirmation si le texte a changé — même
 * principe que la sortie du TUI : rien ne se perd en silence.
 */
import { useEffect, useRef, useState } from "react";
import { TextAttributes } from "@opentui/core";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { readPromptFile, writePromptFile } from "../state/prompt-file";
import { KeyHints } from "../ui/KeyHints";
import { ACCENT, BAD, DIM, FAINT, WARN } from "../ui/theme";

export interface PromptEditorProps {
  root: string;
  roleName: string;
  /** Chemin relatif déclaré par le rôle — jamais vide : l'appelant en propose un par défaut au besoin. */
  systemPromptFile: string;
  /** Fermeture demandée. `saved` dit si le fichier a été écrit, pour que l'appelant rafraîchisse son aperçu. */
  onClose: (saved: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
}

export function PromptEditor({ root, roleName, systemPromptFile, onClose, notify }: PromptEditorProps) {
  const [loaded, setLoaded] = useState<{ content: string; path: string; exists: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const area = useRef<TextareaRenderable | null>(null);

  useEffect(() => {
    void readPromptFile(root, systemPromptFile)
      .then(setLoaded)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [root, systemPromptFile]);

  async function save(): Promise<void> {
    const content = area.current?.plainText ?? loaded?.content ?? "";
    try {
      const path = await writePromptFile(root, systemPromptFile, content);
      setLoaded((current) => (current ? { ...current, content, exists: true } : current));
      setDirty(false);
      setConfirmDiscard(false);
      notify(`Prompt du rôle "${roleName}" enregistré dans ${path}.`);
      onClose(true);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), true);
    }
  }

  // Sans champ de saisie monté, plus rien ne reçoit les touches : ce
  // gestionnaire global est le seul moyen de ressortir d'une erreur de
  // lecture. Inerte le reste du temps, où la saisie a le clavier.
  useKeyboard((key) => {
    if (error && (key.name === "escape" || key.name === "return")) onClose(false);
  });

  if (error) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <text fg={ACCENT} attributes={TextAttributes.BOLD}>{`Prompt système · ${roleName}`}</text>
        <text fg={BAD}>{error}</text>
        <box marginTop={1}>
          <KeyHints hints={[{ key: "Échap", label: "revenir aux rôles" }]} />
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row">
        <text fg={ACCENT} attributes={TextAttributes.BOLD}>{`Prompt système · ${roleName}`}</text>
        {dirty ? <text fg={WARN}>{"   ● modifié"}</text> : null}
      </box>
      <text fg={DIM}>{loaded ? loaded.path : "chargement…"}</text>
      <text fg={FAINT}>
        {loaded && !loaded.exists
          ? "Nouveau fichier — il sera créé à l'enregistrement."
          : "Ce texte est placé en tête du contexte transmis à l'agent, avant l'objectif de la tâche."}
      </text>

      <box flexGrow={1} border borderStyle="single" borderColor={ACCENT} marginTop={1} marginBottom={1}>
        {loaded ? (
          <textarea
            ref={area}
            focused
            initialValue={loaded.content}
            wrapMode="word"
            flexGrow={1}
            placeholder="(prompt vide — écrivez ce que l'agent doit savoir avant de recevoir la tâche)"
            onContentChange={() => setDirty((area.current?.plainText ?? "") !== loaded.content)}
            onKeyDown={(key) => {
              if (key.name === "s" && key.ctrl) {
                key.preventDefault();
                void save();
              } else if (key.name === "escape") {
                key.preventDefault();
                // Une frappe pour signaler ce qu'on va perdre, une seconde
                // pour l'assumer — plutôt qu'une fenêtre modale qui volerait
                // le clavier au champ de saisie.
                if (dirty && !confirmDiscard) setConfirmDiscard(true);
                else onClose(false);
              } else if (confirmDiscard) {
                setConfirmDiscard(false);
              }
            }}
          />
        ) : null}
      </box>

      {confirmDiscard ? (
        <text fg={WARN}>Modifications non enregistrées — Échap à nouveau pour les abandonner, Ctrl+S pour enregistrer.</text>
      ) : (
        <KeyHints
          hints={[
            { key: "Ctrl+S", label: "enregistrer le fichier" },
            { key: "Échap", label: "revenir aux rôles" },
          ]}
        />
      )}
    </box>
  );
}
