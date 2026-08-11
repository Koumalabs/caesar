/**
 * Chrome général du TUI de configuration : onglets, portée d'édition,
 * enregistrement, aide.
 *
 * Trois zones, toujours aux mêmes places — c'est ce qui rend l'écran
 * lisible : un bandeau (où je suis), le corps (ce que je règle), un pied
 * (ce que "s" écrira, et ce que je peux taper maintenant).
 *
 * `Tab`/`Maj-Tab` change d'écran, `1`-`4` y va directement, `s` enregistre
 * les modifications en attente sur la couche active (jamais implicitement),
 * `p` fait cycler la **portée d'édition** (global → projet → local), `q`
 * quitte (avec confirmation si des modifications sont en attente), `?`
 * affiche l'aide.
 *
 * La portée est l'information la plus importante de cet écran dès lors qu'on
 * peut écrire à trois endroits : elle reste visible en permanence, avec le
 * **chemin du fichier** que "s" écrira — savoir « couche projet » ne dit pas
 * où c'est, et c'est justement ce qu'on veut vérifier avant d'enregistrer.
 * Sa couleur est propre à chaque couche, « global » en rouge : c'est
 * l'erreur la plus difficile à défaire (modifier par mégarde un réglage qui
 * vaut pour tous les projets en croyant régler celui-ci). Changer de portée
 * avec des modifications en attente demande confirmation avant de les
 * abandonner — même principe que la confirmation de sortie.
 *
 * Cet écran doit être utile immédiatement : `state` charge vite (trois
 * fichiers TOML locaux) et s'affiche dès qu'il est prêt, sans attendre la
 * détection d'installation des agents, réellement lente (elle sonde chaque
 * binaire). Celle-ci se charge une seule fois ici, jamais à chaque frappe.
 */
import { useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { AgentInstallStatus, ConfigScope } from "@orch/core";
import { detectAgentInstallation, listAgentDefinitions } from "@orch/core";
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

/** Couleur de la marque de portée — « global » en rouge : c'est l'erreur la plus difficile à défaire. */
const SCOPE_COLOR: Record<ConfigScope, string> = { global: BAD, project: ACCENT, local: "#C792EA" };

export interface AppProps {
  root: string;
  renderer: CliRenderer;
}

const TABS = ["Agents", "Rôles", "Politique", "Intégrations"] as const;

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
    // Une seule détection, au montage — jamais relancée à chaque frappe.
    // `detectAgentInstallation` (`@orch/core`) est la même détection
    // qu'`orch doctor`/`orch agents list` font, pas une réécriture.
    void Promise.all(listAgentDefinitions().map(async (def) => [def.id, await detectAgentInstallation(def)] as const))
      .then((entries) => setInstalledStatus(new Map(entries)))
      .catch(() => {
        // Dormant aujourd'hui : `detectAgentInstallation` avale déjà ses
        // propres erreurs. Ce filet reste nécessaire pour que ce comportement
        // ne devienne pas un détail d'implémentation dont dépendrait
        // silencieusement l'écran — sans lui, tous les écrans resteraient
        // bloqués sur « détection en cours » si un appel se mettait un jour à
        // lever. Un statut vide dégrade proprement.
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
      // Chemin raccourci par la gauche : le message tient alors sur une
      // ligne, et la barre d'état juste dessous en porte la version entière.
      notify(`Enregistré dans ${elideLeft(activeScopePath(root, saved), 52)} (couche ${scopeLabel(saved.activeScope)}).`);
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

  /** Bascule vers la portée suivante — jamais sans confirmation si des modifications sont en attente. */
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
    // Un champ texte, l'éditeur de prompt ou une fenêtre modale possède le
    // clavier : ce gestionnaire global ne doit rien intercepter (sinon taper
    // "s" dans un nom de rôle déclencherait un enregistrement, entre autres
    // surprises).
    if (editingText || showHelp || showQuitConfirm || showScopeConfirm) return;

    if (key.name === "tab" && key.shift) setTab((t) => (t - 1 + TABS.length) % TABS.length);
    else if (key.name === "tab") setTab((t) => (t + 1) % TABS.length);
    else if (/^[1-4]$/.test(key.name)) setTab(Number(key.name) - 1);
    else if (key.name === "s") void handleSave();
    else if (key.name === "p") switchScope();
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
  const scope = state?.activeScope ?? "project";

  // Barre d'état : trois informations sur une seule ligne, dont un chemin de
  // longueur imprévisible. Les largeurs se calculent ici plutôt que d'être
  // laissées au repli du terminal, qui coupait le sélecteur de portée en deux.
  // -4 : le remplissage gauche et droit de la boîte racine, plus une
  // colonne de garde — une ligne exactement à la largeur du terminal perdait
  // son dernier caractère à la capture.
  const contentWidth = Math.max(20, width - 4);
  const scopeChip = ` PORTÉE : ${scopeLabel(scope).toUpperCase()} `;
  const statusText = saving ? "enregistrement…" : dirty ? "● modifications non enregistrées" : "✓ tout est enregistré";
  const scopePath = state ? activeScopePath(root, state) : "";
  const pathRoom = contentWidth - scopeChip.length - 2 - statusText.length - 3 - '"s" écrit dans '.length;

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0}>
        <text attributes={TextAttributes.BOLD}>orch config</text>
        {/* La racine est raccourcie par la gauche : sa fin — le nom du projet —
            est ce qui renseigne, et un chemin long repliait sinon le bandeau
            sur deux lignes. */}
        <text fg={DIM}>{`  ${elideLeft(root, Math.max(12, contentWidth - "orch config  ".length))}`}</text>
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
          <text fg={BAD}>Impossible de charger la configuration : {loadError}</text>
        ) : !state ? (
          <text fg={WARN}>Chargement de la configuration…</text>
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
          {/* Replié à la main plutôt que laissé au terminal : un message long
              (un motif de refus, un chemin) recouvrait sinon la barre d'état
              en se repliant par-dessus. */}
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
        {/* Le chemin, et pas seulement le nom de la couche : « couche projet »
            ne dit pas *où*, et c'est justement ce qu'on veut vérifier avant
            d'appuyer sur "s". Raccourci par la gauche pour tenir sur la ligne :
            trois `<text>` d'une largeur cumulée supérieure à celle du terminal
            se repliaient, et coupaient « PORTÉE : PROJET » en deux. */}
        {pathRoom >= 24 ? (
          <text fg={DIM}>{`   "s" écrit dans ${elideLeft(scopePath, pathRoom)}`}</text>
        ) : null}
      </box>

      <KeyHints
        hints={[
          { key: "Tab", label: "écran" },
          { key: "s", label: "enregistrer" },
          { key: "p", label: "changer de portée" },
          { key: "?", label: "aide" },
          { key: "q", label: "quitter" },
        ]}
      />
    </box>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  useKeyboard(() => onClose());
  return (
    <box flexDirection="column" border borderStyle="double" borderColor={ACCENT} title=" Aide — une touche pour fermer " paddingLeft={1} paddingRight={1}>
      <text attributes={TextAttributes.BOLD}>Partout</text>
      <text>{"  Tab / Maj-Tab, ou 1-4 : changer d'écran"}</text>
      <text>{"  s : enregistrer les modifications en attente sur la couche active"}</text>
      <text>{"  p : changer de portée d'édition (global → projet → local)"}</text>
      <text fg={DIM}>{"      Ce que \"s\" enregistre. Confirmation si des modifications sont en attente."}</text>
      <text>{"  q ou Ctrl+C : quitter (confirmation si des modifications sont en attente)"}</text>
      <text fg={FAINT}>{"  Rien n'est écrit sur disque avant \"s\" — sauf le prompt système, voir Rôles."}</text>
      <text> </text>

      <text attributes={TextAttributes.BOLD}>Agents</text>
      <text>{"  ↑↓ : agent · Espace : autoriser / refuser · Entrée : éditer un agent déclaré"}</text>
      <text>{"  n : déclarer un CLI hors catalogue · x : retirer une déclaration"}</text>
      <text fg={DIM}>{"      Autoriser et déclarer sont deux gestes différents : le premier écrit une"}</text>
      <text fg={DIM}>{"      liste de la politique, le second ajoute un agent au catalogue."}</text>
      <text> </text>

      <text attributes={TextAttributes.BOLD}>Rôles</text>
      <text>{"  ↑↓ : rôle · Entrée : entrer dans les champs · n : nouveau · x : supprimer"}</text>
      <text>{"  Dans les champs : Entrée modifie, Échap revient. Sur « Agents », Entrée ouvre"}</text>
      <text>{"  l'ordre de repli — Maj+J/Maj+K déplace, a ajoute, r retire."}</text>
      <text>{"  Sur « Prompt système » : Entrée ouvre l'éditeur (Ctrl+S écrit le fichier),"}</text>
      <text>{"  f change le chemin du fichier."}</text>
      <text> </text>

      <text attributes={TextAttributes.BOLD}>Politique</text>
      <text>{"  ↑↓ : réglage · Entrée : modifier ou ouvrir la liste · a ajoute, r retire"}</text>
      <text attributes={TextAttributes.BOLD}>Intégrations</text>
      <text>{"  ↑↓ : client · Entrée : installer / mettre à jour l'enregistrement MCP"}</text>
    </box>
  );
}

function QuitConfirmOverlay({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  useKeyboard((key) => {
    if (key.name === "o" || key.name === "y") onConfirm();
    else if (key.name === "n" || key.name === "escape") onCancel();
  });
  return (
    <box flexDirection="column" border borderStyle="double" borderColor={BAD} title=" Modifications non enregistrées " paddingLeft={1} paddingRight={1}>
      <text>Des modifications ne sont pas enregistrées. Quitter quand même ?</text>
      <text fg={DIM}>o : quitter sans enregistrer · n / Échap : annuler</text>
    </box>
  );
}

/**
 * Changer de portée avec des modifications en attente les abandonnerait
 * silencieusement (elles ne portent que sur la couche active) : ce garde-fou
 * demande confirmation avant, même principe que `QuitConfirmOverlay`.
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
    <box flexDirection="column" border borderStyle="double" borderColor={BAD} title=" Modifications non enregistrées " paddingLeft={1} paddingRight={1}>
      <text>
        Les modifications en attente sur la couche {scopeLabel(from)} ne sont pas enregistrées. Basculer vers la couche{" "}
        {scopeLabel(to)} les abandonnera. Continuer ?
      </text>
      <text fg={DIM}>o : changer de portée sans enregistrer · n / Échap : annuler</text>
    </box>
  );
}
