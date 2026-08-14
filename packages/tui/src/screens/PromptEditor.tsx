/**
 * Full-screen editor for a role's system prompt — the text `resolveRole`
 * places at the head of the context passed to the agent (`delegation.ts`).
 * It is *the* agent's prompt for this role: until now the TUI only showed
 * its path, and one had to leave the tool to change a word of it.
 *
 * Two things set it apart from the rest of the TUI, and the screen states
 * them both rather than letting them surprise:
 *
 *  - **it writes immediately.** Ctrl+S saves the file, without going
 *    through the global "s" or the editing scope: a prompt is a single
 *    file, not a three-layer setting (see `prompt-file.ts`).
 *  - **it names the file the engine will read**, absolute path shown at
 *    the top, computed by `rolePromptPath` (`@caesar/core`) — the very one
 *    `resolveRole` opens. A role coming from the global layer resolves its
 *    prompt in the current project: the path shows it, rather than letting
 *    one believe in a file shared between projects.
 *
 * Esc abandons, and asks for confirmation if the text changed — same
 * principle as quitting the TUI: nothing is lost silently.
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
  /** Relative path declared by the role — never empty: the caller proposes a default one when needed. */
  systemPromptFile: string;
  /** Close requested. `saved` says whether the file was written, so the caller can refresh its preview. */
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
      notify(`Prompt for role "${roleName}" saved to ${path}.`);
      onClose(true);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), true);
    }
  }

  // With no input field mounted, nothing receives the keys anymore: this
  // global handler is the only way out of a read error. Inert the rest of
  // the time, when the textarea has the keyboard.
  useKeyboard((key) => {
    if (error && (key.name === "escape" || key.name === "return")) onClose(false);
  });

  if (error) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <text fg={ACCENT} attributes={TextAttributes.BOLD}>{`System prompt · ${roleName}`}</text>
        <text fg={BAD}>{error}</text>
        <box marginTop={1}>
          <KeyHints hints={[{ key: "Esc", label: "back to roles" }]} />
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row">
        <text fg={ACCENT} attributes={TextAttributes.BOLD}>{`System prompt · ${roleName}`}</text>
        {dirty ? <text fg={WARN}>{"   ● modified"}</text> : null}
      </box>
      <text fg={DIM}>{loaded ? loaded.path : "loading…"}</text>
      <text fg={FAINT}>
        {loaded && !loaded.exists
          ? "New file — it will be created on save."
          : "This text is placed at the head of the context passed to the agent, before the task's objective."}
      </text>

      <box flexGrow={1} border borderStyle="single" borderColor={ACCENT} marginTop={1} marginBottom={1}>
        {loaded ? (
          <textarea
            ref={area}
            focused
            initialValue={loaded.content}
            wrapMode="word"
            flexGrow={1}
            placeholder="(empty prompt — write what the agent must know before receiving the task)"
            onContentChange={() => setDirty((area.current?.plainText ?? "") !== loaded.content)}
            onKeyDown={(key) => {
              if (key.name === "s" && key.ctrl) {
                key.preventDefault();
                void save();
              } else if (key.name === "escape") {
                key.preventDefault();
                // One keystroke to point out what is about to be lost, a
                // second to own it — rather than a modal window that would
                // steal the keyboard from the textarea.
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
        <text fg={WARN}>Unsaved changes — Esc again to discard them, Ctrl+S to save.</text>
      ) : (
        <KeyHints
          hints={[
            { key: "Ctrl+S", label: "save the file" },
            { key: "Esc", label: "back to roles" },
          ]}
        />
      )}
    </box>
  );
}
