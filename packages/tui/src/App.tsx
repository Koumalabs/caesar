/**
 * Onglets et navigation générale du TUI de configuration.
 *
 * `Tab`/`Shift-Tab` change d'écran, `s` enregistre les modifications en
 * attente (`config-state.ts`, jamais implicite — voir le brief), `q` quitte
 * (avec confirmation si des modifications sont en attente), `?` affiche
 * l'aide. Un indicateur permanent (bas d'écran) signale les modifications
 * non enregistrées.
 *
 * Cet écran (le premier affiché, l'onglet Agents) doit être utile
 * immédiatement : `state` (la configuration) charge vite — un fichier TOML
 * local — et s'affiche dès qu'il est prêt, sans attendre la détection
 * d'installation des agents, réellement lente (elle sonde chaque binaire).
 * Celle-ci se charge une seule fois ici, jamais à chaque frappe, et chaque
 * écran affiche son propre état de chargement tant qu'elle n'a pas répondu.
 */
import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { AgentInstallStatus } from "@orch/core";
import { detectAgentInstallation, listAgentDefinitions } from "@orch/core";
import { AgentsScreen } from "./screens/AgentsScreen";
import { IntegrationsScreen } from "./screens/IntegrationsScreen";
import { PolicyScreen } from "./screens/PolicyScreen";
import { RolesScreen } from "./screens/RolesScreen";
import { isDirty, loadConfigState, saveConfigState, toggleAgentDenied, type ConfigState } from "./state/config-state";

export interface AppProps {
  root: string;
  renderer: CliRenderer;
}

const TABS = ["Agents", "Rôles", "Politique", "Intégrations"] as const;

export function App({ root, renderer }: AppProps) {
  const [state, setState] = useState<ConfigState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installedStatus, setInstalledStatus] = useState<Map<string, AgentInstallStatus> | null>(null);
  const [tab, setTab] = useState(0);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [editingText, setEditingText] = useState(false);

  useEffect(() => {
    void loadConfigState(root)
      .then(setState)
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)));
  }, [root]);

  useEffect(() => {
    // Une seule détection, au montage — jamais relancée à chaque frappe
    // (voir le brief). `detectAgentInstallation` (`@orch/core`) est la même
    // détection qu'`orch doctor`/`orch agents list` font, pas une réécriture.
    void Promise.all(listAgentDefinitions().map(async (def) => [def.id, await detectAgentInstallation(def)] as const)).then(
      (entries) => setInstalledStatus(new Map(entries)),
    );
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
      notify("Enregistré.");
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

  useKeyboard((key) => {
    // Un champ texte ou une fenêtre modale possède le clavier : ce
    // gestionnaire global ne doit rien intercepter (sinon taper "s" dans un
    // nom de rôle déclencherait un enregistrement, entre autres surprises).
    if (editingText || showHelp || showQuitConfirm) return;

    if (key.name === "tab" && key.shift) setTab((t) => (t - 1 + TABS.length) % TABS.length);
    else if (key.name === "tab") setTab((t) => (t + 1) % TABS.length);
    else if (key.name === "s") void handleSave();
    else if (key.name === "q" || (key.name === "c" && key.ctrl)) {
      // "q" et Ctrl+C empruntent exactement le même chemin : `main.tsx`
      // désactive la sortie automatique d'OpenTUI sur Ctrl+C
      // (`exitOnCtrlC: false`) précisément pour que ce garde-fou s'applique
      // aussi à lui — sinon les modifications en attente seraient perdues
      // sans confirmation, le pire défaut possible pour cet outil.
      if (state && isDirty(state)) setShowQuitConfirm(true);
      else quit();
    } else if (key.name === "?") setShowHelp(true);
  });

  const installedBool = installedStatus ? new Map([...installedStatus].map(([id, s]) => [id, s.installed] as const)) : null;
  const dirty = state ? isDirty(state) : false;

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" paddingLeft={1}>
        <text attributes={TextAttributes.BOLD}>orch config</text>
        <text fg="gray">{"  " + root}</text>
      </box>
      <box flexDirection="row" paddingLeft={1} marginBottom={1}>
        {TABS.map((label, index) => (
          <text key={label} fg={index === tab ? "black" : "white"} bg={index === tab ? "cyan" : undefined}>
            {` ${label} `}
          </text>
        ))}
      </box>

      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        {loadError ? (
          <text fg="red">Impossible de charger la configuration : {loadError}</text>
        ) : !state ? (
          <text fg="yellow">Chargement de la configuration…</text>
        ) : showHelp ? (
          <HelpOverlay onClose={() => setShowHelp(false)} />
        ) : showQuitConfirm ? (
          <QuitConfirmOverlay onConfirm={quit} onCancel={() => setShowQuitConfirm(false)} />
        ) : tab === 0 ? (
          <AgentsScreen state={state} installed={installedStatus} onToggleDenied={(id) => setState(toggleAgentDenied(state, id))} />
        ) : tab === 1 ? (
          <RolesScreen state={state} installed={installedBool} onChange={setState} onEditingChange={setEditingText} notify={notify} />
        ) : tab === 2 ? (
          <PolicyScreen state={state} onChange={setState} onEditingChange={setEditingText} notify={notify} />
        ) : (
          <IntegrationsScreen root={root} notify={notify} />
        )}
      </box>

      <box flexDirection="row" paddingLeft={1}>
        <text fg={dirty ? "yellow" : "green"}>
          {saving ? "Enregistrement…" : dirty ? "● modifications non enregistrées" : "✓ tout est enregistré"}
        </text>
        {message ? <text fg={message.isError ? "red" : "gray"}>{"   " + message.text}</text> : null}
      </box>
      <box flexDirection="row" paddingLeft={1}>
        <text fg="gray">Tab/Maj-Tab : écran · s : enregistrer · q ou Ctrl+C : quitter · ? : aide</text>
      </box>
    </box>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  useKeyboard(() => onClose());
  return (
    <box flexDirection="column" border borderStyle="double" title="Aide (une touche pour fermer)">
      <text>Tab / Maj-Tab : écran suivant / précédent</text>
      <text>s : enregistrer les modifications en attente</text>
      <text>q ou Ctrl+C : quitter (confirmation si des modifications sont en attente)</text>
      <text> </text>
      <text attributes={TextAttributes.BOLD}>Agents</text>
      <text>  Haut/Bas : ligne · Espace : autorisation · Entrée : détail des capacités</text>
      <text attributes={TextAttributes.BOLD}>Rôles</text>
      <text>  Haut/Bas : rôle · n : nouveau rôle · x : supprimer le rôle sélectionné</text>
      <text>  Entrée sur un rôle : éditer ses champs (Haut/Bas, Entrée, Échap pour sortir)</text>
      <text>  champ "agents", puis Entrée : ordre de repli — Haut/Bas déplace le curseur,</text>
      <text>  Maj+J/Maj+K réordonne, a ajoute un agent du catalogue, r le retire</text>
      <text attributes={TextAttributes.BOLD}>Politique</text>
      <text>  Haut/Bas : champ · Entrée : éditer/cycler · listes : a ajoute, r retire</text>
      <text attributes={TextAttributes.BOLD}>Intégrations</text>
      <text>  Haut/Bas : client · Entrée : installer / mettre à jour l'enregistrement MCP</text>
    </box>
  );
}

function QuitConfirmOverlay({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  useKeyboard((key) => {
    if (key.name === "o" || key.name === "y") onConfirm();
    else if (key.name === "n" || key.name === "escape") onCancel();
  });
  return (
    <box flexDirection="column" border borderStyle="double" borderColor="red" title="Modifications non enregistrées">
      <text>Des modifications ne sont pas enregistrées. Quitter quand même ?</text>
      <text fg="gray">o : quitter sans enregistrer · n / Échap : annuler</text>
    </box>
  );
}
