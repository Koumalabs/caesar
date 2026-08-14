/**
 * General chrome of the configuration TUI: tabs, editing scope, saving,
 * help.
 *
 * Three zones, always in the same places — that is what makes the screen
 * readable: a banner (where I am), the body (what I am adjusting), a
 * footer (what "s" will write, and what I can type right now).
 *
 * `Tab`/`Shift-Tab` switches screens, `1`-`4` jumps straight to one, `s`
 * saves the pending changes on the active layer (never implicitly), `p`
 * cycles the **editing scope** (global → project → local), `q` quits
 * (with confirmation if changes are pending), `?` shows the help.
 *
 * The scope is the most important piece of information on this screen once
 * writing can happen in three places: it stays visible at all times, along
 * with the **file path** that "s" will write — knowing "project layer"
 * does not say where that is, and that is precisely what one wants to
 * check before saving. Its color is specific to each layer, "global" in
 * red: it is the hardest mistake to undo (accidentally editing a setting
 * that applies to every project while believing you are adjusting this
 * one). Switching scope with pending changes asks for confirmation before
 * discarding them — same principle as the quit confirmation.
 *
 * This screen must be useful immediately: `state` loads fast (three local
 * TOML files) and is displayed as soon as it is ready, without waiting for
 * the agent installation detection, which is genuinely slow (it probes
 * every binary). That detection loads once here, never on each keystroke.
 */
import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { AgentInstallStatus, ConfigScope } from "@caesar/core";
import { detectAgentInstallation, listAgentDefinitions } from "@caesar/core";
import { AgentsScreen } from "./screens/AgentsScreen";
import { IntegrationsScreen } from "./screens/IntegrationsScreen";
import { PolicyScreen } from "./screens/PolicyScreen";
import { RolesScreen } from "./screens/RolesScreen";
import { KeyHints } from "./ui/KeyHints";
import { elideLeft, wrap } from "./ui/layout";
import { ACCENT, ACCENT_INK, BAD, DIM, FAINT, OK, WARN } from "./ui/theme";
import {
  activeScopePath,
  isDirty,
  loadConfigState,
  nextScope,
  saveConfigState,
  scopeLabel,
  setScope,
  toggleAgentDenied,
  type ConfigState,
} from "./state/config-state";

/** Color of the scope mark — "global" in red: it is the hardest mistake to undo. */
const SCOPE_COLOR: Record<ConfigScope, string> = { global: BAD, project: ACCENT, local: "#C792EA" };

export interface AppProps {
  root: string;
  renderer: CliRenderer;
}

const TABS = ["Agents", "Roles", "Policy", "Integrations"] as const;

export function App({ root, renderer }: AppProps) {
  const { width } = useTerminalDimensions();
  const [state, setState] = useState<ConfigState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installedStatus, setInstalledStatus] = useState<Map<string, AgentInstallStatus> | null>(null);
  const [tab, setTab] = useState(0);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [showScopeConfirm, setShowScopeConfirm] = useState(false);
  const [editingText, setEditingText] = useState(false);

  useEffect(() => {
    void loadConfigState(root)
      .then(setState)
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)));
  }, [root]);

  useEffect(() => {
    // A single detection, on mount — never rerun on each keystroke.
    // `detectAgentInstallation` (`@caesar/core`) is the same detection
    // that `caesar doctor`/`caesar agents list` perform, not a rewrite.
    void Promise.all(listAgentDefinitions().map(async (def) => [def.id, await detectAgentInstallation(def)] as const))
      .then((entries) => setInstalledStatus(new Map(entries)))
      .catch(() => {
        // Dormant today: `detectAgentInstallation` already swallows its
        // own errors. This net remains necessary so that this behavior
        // does not become an implementation detail the screen silently
        // depends on — without it, every screen would stay stuck on
        // "detection in progress" if a call ever started throwing. An
        // empty status degrades cleanly.
        setInstalledStatus(new Map());
      });
  }, []);

  function notify(text: string, isError = false): void {
    setMessage({ text, isError });
  }

  async function handleSave(): Promise<void> {
    if (!state) return;
    setSaving(true);
    try {
      const saved = await saveConfigState(root, state);
      setState(saved);
      // Path elided from the left: the message then fits on one line, and
      // the status bar just below carries the full version.
      notify(`Saved to ${elideLeft(activeScopePath(root, saved), 52)} (${scopeLabel(saved.activeScope)} layer).`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setSaving(false);
    }
  }

  function quit(): void {
    renderer.destroy();
    process.exit(0);
  }

  /** Switches to the next scope — never without confirmation if changes are pending. */
  function switchScope(): void {
    if (!state) return;
    if (isDirty(state)) {
      setShowScopeConfirm(true);
      return;
    }
    setState(setScope(state, nextScope(state.activeScope)));
  }

  function confirmSwitchScope(): void {
    if (state) setState(setScope(state, nextScope(state.activeScope)));
    setShowScopeConfirm(false);
  }

  useKeyboard((key) => {
    // A text field, the prompt editor or a modal window owns the keyboard:
    // this global handler must intercept nothing (otherwise typing "s" in
    // a role name would trigger a save, among other surprises).
    if (editingText || showHelp || showQuitConfirm || showScopeConfirm) return;

    if (key.name === "tab" && key.shift) setTab((t) => (t - 1 + TABS.length) % TABS.length);
    else if (key.name === "tab") setTab((t) => (t + 1) % TABS.length);
    else if (/^[1-4]$/.test(key.name)) setTab(Number(key.name) - 1);
    else if (key.name === "s") void handleSave();
    else if (key.name === "p") switchScope();
    else if (key.name === "q" || (key.name === "c" && key.ctrl)) {
      // "q" and Ctrl+C take exactly the same path: `main.tsx` disables
      // OpenTUI's automatic exit on Ctrl+C (`exitOnCtrlC: false`)
      // precisely so that this safeguard also applies to it — otherwise
      // pending changes would be lost without confirmation, the worst
      // possible flaw for this tool.
      if (state && isDirty(state)) setShowQuitConfirm(true);
      else quit();
    } else if (key.name === "?") setShowHelp(true);
  });

  const installedBool = installedStatus ? new Map([...installedStatus].map(([id, s]) => [id, s.installed] as const)) : null;
  const dirty = state ? isDirty(state) : false;
  const scope = state?.activeScope ?? "project";

  // Status bar: three pieces of information on a single line, including a
  // path of unpredictable length. Widths are computed here rather than left
  // to the terminal's wrapping, which used to cut the scope selector in two.
  // -4: the root box's left and right padding, plus one guard column — a
  // line exactly as wide as the terminal lost its last character in the
  // capture.
  const contentWidth = Math.max(20, width - 4);
  const scopeChip = ` SCOPE: ${scopeLabel(scope).toUpperCase()} `;
  const statusText = saving ? "saving…" : dirty ? "● unsaved changes" : "✓ all changes saved";
  const scopePath = state ? activeScopePath(root, state) : "";
  const pathRoom = contentWidth - scopeChip.length - 2 - statusText.length - 3 - '"s" writes to '.length;

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0}>
        <text attributes={TextAttributes.BOLD}>caesar config</text>
        {/* The root is elided from the left: its end — the project name —
            is what informs, and a long path otherwise wrapped the banner
            onto two lines. */}
        <text fg={DIM}>{`  ${elideLeft(root, Math.max(12, contentWidth - "caesar config  ".length))}`}</text>
      </box>

      <box flexDirection="row" marginBottom={1} flexShrink={0}>
        {TABS.map((label, index) => (
          <box key={label} flexDirection="row" marginRight={1}>
            <text
              fg={index === tab ? ACCENT_INK : DIM}
              bg={index === tab ? ACCENT : undefined}
              attributes={index === tab ? TextAttributes.BOLD : undefined}
            >
              {` ${index + 1} ${label} `}
            </text>
          </box>
        ))}
      </box>

      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {loadError ? (
          <text fg={BAD}>Cannot load the configuration: {loadError}</text>
        ) : !state ? (
          <text fg={WARN}>Loading the configuration…</text>
        ) : showHelp ? (
          <HelpOverlay onClose={() => setShowHelp(false)} />
        ) : showQuitConfirm ? (
          <QuitConfirmOverlay onConfirm={quit} onCancel={() => setShowQuitConfirm(false)} />
        ) : showScopeConfirm ? (
          <ScopeConfirmOverlay
            from={state.activeScope}
            to={nextScope(state.activeScope)}
            onConfirm={confirmSwitchScope}
            onCancel={() => setShowScopeConfirm(false)}
          />
        ) : tab === 0 ? (
          <AgentsScreen
            state={state}
            installed={installedStatus}
            onToggleDenied={(id) => setState(toggleAgentDenied(state, id))}
            onChange={setState}
            onEditingChange={setEditingText}
            notify={notify}
          />
        ) : tab === 1 ? (
          <RolesScreen
            root={root}
            state={state}
            installed={installedBool}
            onChange={setState}
            onEditingChange={setEditingText}
            notify={notify}
          />
        ) : tab === 2 ? (
          <PolicyScreen state={state} onChange={setState} onEditingChange={setEditingText} notify={notify} />
        ) : (
          <IntegrationsScreen root={root} notify={notify} />
        )}
      </box>

      {message ? (
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          {/* Wrapped by hand rather than left to the terminal: a long
              message (a refusal reason, a path) otherwise wrapped over the
              status bar and covered it. */}
          {wrap(`${message.isError ? "✗" : "✓"} ${message.text}`, contentWidth)
            .slice(0, 2)
            .map((line, index) => (
              <text key={index} fg={message.isError ? BAD : OK}>
                {line}
              </text>
            ))}
        </box>
      ) : null}

      <box flexDirection="row" marginTop={1} flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={ACCENT_INK} bg={SCOPE_COLOR[scope]}>
          {scopeChip}
        </text>
        <text fg={saving || dirty ? WARN : OK}>{`  ${statusText}`}</text>
        {/* The path, and not just the layer name: "project layer" does not
            say *where*, and that is precisely what one wants to check
            before pressing "s". Elided from the left to fit on the line:
            three `<text>` whose cumulative width exceeded the terminal's
            wrapped, and cut "SCOPE: PROJECT" in two. */}
        {pathRoom >= 24 ? (
          <text fg={DIM}>{`   "s" writes to ${elideLeft(scopePath, pathRoom)}`}</text>
        ) : null}
      </box>

      <KeyHints
        hints={[
          { key: "Tab", label: "screen" },
          { key: "s", label: "save" },
          { key: "p", label: "switch scope" },
          { key: "?", label: "help" },
          { key: "q", label: "quit" },
        ]}
      />
    </box>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  useKeyboard(() => onClose());
  return (
    <box flexDirection="column" border borderStyle="double" borderColor={ACCENT} title=" Help — any key to close " paddingLeft={1} paddingRight={1}>
      <text attributes={TextAttributes.BOLD}>Everywhere</text>
      <text>{"  Tab / Shift-Tab, or 1-4: switch screens"}</text>
      <text>{"  s: save the pending changes on the active layer"}</text>
      <text>{"  p: switch the editing scope (global → project → local)"}</text>
      <text fg={DIM}>{"      What \"s\" saves. Confirmation if changes are pending."}</text>
      <text>{"  q or Ctrl+C: quit (confirmation if changes are pending)"}</text>
      <text fg={FAINT}>{"  Nothing is written to disk before \"s\" — except the system prompt, see Roles."}</text>
      <text> </text>

      <text attributes={TextAttributes.BOLD}>Agents</text>
      <text>{"  ↑↓: agent · Space: allow / deny · Enter: edit a declared agent"}</text>
      <text>{"  n: declare a CLI outside the catalog · x: remove a declaration"}</text>
      <text fg={DIM}>{"      Allowing and declaring are two different gestures: the first writes a"}</text>
      <text fg={DIM}>{"      policy list, the second adds an agent to the catalog."}</text>
      <text> </text>

      <text attributes={TextAttributes.BOLD}>Roles</text>
      <text>{"  ↑↓: role · Enter: enter the fields · n: new · x: delete"}</text>
      <text>{"  In the fields: Enter edits, Esc goes back. On \"Agents\", Enter opens the"}</text>
      <text>{"  fallback order — Shift+J/Shift+K moves, a adds, r removes."}</text>
      <text>{"  On \"System prompt\": Enter opens the editor (Ctrl+S writes the file),"}</text>
      <text>{"  f changes the file path."}</text>
      <text> </text>

      <text attributes={TextAttributes.BOLD}>Policy</text>
      <text>{"  ↑↓: setting · Enter: edit or open the list · a adds, r removes"}</text>
      <text attributes={TextAttributes.BOLD}>Integrations</text>
      <text>{"  ↑↓: client · Enter: install / update the MCP registration"}</text>
    </box>
  );
}

function QuitConfirmOverlay({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  useKeyboard((key) => {
    if (key.name === "o" || key.name === "y") onConfirm();
    else if (key.name === "n" || key.name === "escape") onCancel();
  });
  return (
    <box flexDirection="column" border borderStyle="double" borderColor={BAD} title=" Unsaved changes " paddingLeft={1} paddingRight={1}>
      <text>Some changes are not saved. Quit anyway?</text>
      <text fg={DIM}>y: quit without saving · n / Esc: cancel</text>
    </box>
  );
}

/**
 * Switching scope with pending changes would silently discard them (they
 * only concern the active layer): this safeguard asks for confirmation
 * first, same principle as `QuitConfirmOverlay`.
 */
function ScopeConfirmOverlay({
  from,
  to,
  onConfirm,
  onCancel,
}: {
  from: ConfigScope;
  to: ConfigScope;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useKeyboard((key) => {
    if (key.name === "o" || key.name === "y") onConfirm();
    else if (key.name === "n" || key.name === "escape") onCancel();
  });
  return (
    <box flexDirection="column" border borderStyle="double" borderColor={BAD} title=" Unsaved changes " paddingLeft={1} paddingRight={1}>
      <text>
        The pending changes on the {scopeLabel(from)} layer are not saved. Switching to the {scopeLabel(to)} layer will
        discard them. Continue?
      </text>
      <text fg={DIM}>y: switch scope without saving · n / Esc: cancel</text>
    </box>
  );
}
