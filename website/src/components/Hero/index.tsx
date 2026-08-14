import type {ReactNode} from 'react';
import {useEffect, useState} from 'react';
import Link from '@docusaurus/Link';
import Translate, {translate} from '@docusaurus/Translate';
import SectionHeader from '../SectionHeader';
import styles from './styles.module.css';

/**
 * The hero panel plays the product's core loop: a Claude instance driving
 * an OpenCode delegation through caesar's MCP tools. Tool names, argument
 * names and report fields are the real ones from packages/mcp-server
 * (caesar_delegate → task_id, caesar_await → normalized report with
 * changes_verified_by, caesar_apply → git apply --3way, never a commit);
 * the session itself is abridged, and the caption under the window says so.
 * Purely
 * decorative (`aria-hidden`), hence the animation carries no content of
 * its own; reduced-motion users get the full transcript at rest.
 */
type DemoLine = {
  kind: 'call' | 'arg' | 'result' | 'ok' | 'blank';
  text: string;
};

const DEMO_LINES: readonly DemoLine[] = [
  {kind: 'call', text: '▸ caesar_delegate'},
  {kind: 'arg', text: '    agent: "opencode"'},
  {kind: 'arg', text: '    model: "deepseek-v4-pro"'},
  {kind: 'arg', text: '    isolation: "worktree"'},
  {kind: 'arg', text: '    objective: "Add a --json flag to status"'},
  {kind: 'result', text: '◂ task_id: "t_4b21c9de"'},
  {kind: 'call', text: '▸ caesar_await'},
  {kind: 'ok', text: '◂ succeeded · changes_verified_by: "git"'},
  {kind: 'result', text: '◂ ~ modified src/commands/status.ts'},
  {kind: 'call', text: '▸ caesar_diff'},
  {kind: 'result', text: '◂ the diff — your repo still untouched'},
  {kind: 'call', text: '▸ caesar_apply'},
  {kind: 'ok', text: '◂ applied — git apply --3way, no commit'},
];

const DEMO_TICK_MS = 800;
const DEMO_HOLD_TICKS = 5;

function McpDemo(): ReactNode {
  // SSR and no-JS render the full transcript; the loop only starts on the
  // client, and never starts for prefers-reduced-motion users.
  const [step, setStep] = useState(DEMO_LINES.length);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
    let tick = 0;
    setStep(0);
    const id = window.setInterval(() => {
      tick += 1;
      if (tick > DEMO_LINES.length + DEMO_HOLD_TICKS) {
        tick = 0;
      }
      setStep(Math.min(tick, DEMO_LINES.length));
    }, DEMO_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={styles.demo}>
      <div className={styles.demoTitlebar}>claude code · mcp → caesar</div>
      <pre className={styles.demoBody}>
        {DEMO_LINES.map((line, i) => (
          <span
            key={i}
            className={[
              styles.demoLine,
              line.kind === 'call' && styles.demoCall,
              line.kind === 'arg' && styles.demoArg,
              line.kind === 'result' && styles.demoResult,
              line.kind === 'ok' && styles.demoOk,
              i >= step && styles.demoHidden,
            ]
              .filter(Boolean)
              .join(' ')}>
            {line.text}
          </span>
        ))}
      </pre>
    </div>
  );
}

/**
 * Real, copy-pasteable shell input — technical identifiers stay out of
 * `<Translate>` (same convention as the commands in Quickstart). The curl
 * line pipes `website/static/install` from the production domain; the git
 * line is the manual equivalent the installation guide documents.
 */
const INSTALL_COMMANDS = {
  curl: 'curl -fsSL https://caesar.koumalabs.org/install | sh',
  git: 'git clone https://github.com/Koumalabs/caesar.git && cd caesar && pnpm install && pnpm exec tsc -b',
} as const;

type InstallTab = keyof typeof INSTALL_COMMANDS;

export default function Hero(): ReactNode {
  const [tab, setTab] = useState<InstallTab>('curl');
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard
      .writeText(INSTALL_COMMANDS[tab])
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        /* clipboard unavailable (permissions, http): the command stays selectable */
      });
  };

  const pickTab = (next: InstallTab) => {
    setTab(next);
    setCopied(false);
  };

  return (
    <header className={styles.hero}>
      <div className="container">
        <SectionHeader
          num="01"
          label={<Translate id="homepage.hero.eyebrow">caesar · the orchestrator</Translate>}
          aside={'ramp · 6 stops'}
        />
        <div className={styles.grid}>
          <div className={styles.copy}>
            <h1 className={styles.title}>
              <Translate
                id="homepage.hero.headline"
                values={{
                  safely: (
                    <em className={styles.em}>
                      <Translate id="homepage.hero.headline.em">safely</Translate>
                    </em>
                  ),
                }}>
                {'Delegate coding tasks to external agent CLIs — {safely}.'}
              </Translate>
            </h1>
            <p className={styles.subtext}>
              <Translate id="homepage.hero.subtext">
                One protocol, five providers, and a disposable git worktree between them and
                your repo.
              </Translate>
            </p>

            <div className={styles.installer}>
              <div className={styles.tabs} role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'curl'}
                  className={tab === 'curl' ? styles.tabActive : styles.tab}
                  onClick={() => pickTab('curl')}>
                  curl
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'git'}
                  className={tab === 'git' ? styles.tabActive : styles.tab}
                  onClick={() => pickTab('git')}>
                  git
                </button>
                <span className={styles.tabsAside}>macOS · Linux</span>
              </div>
              <div className={styles.cmdRow}>
                <span aria-hidden="true" className={styles.prompt}>
                  $
                </span>
                <code className={styles.cmd}>{INSTALL_COMMANDS[tab]}</code>
                <button type="button" className={styles.copyBtn} onClick={copy}>
                  {copied ? (
                    <Translate id="homepage.hero.copied">copied</Translate>
                  ) : (
                    <Translate id="homepage.hero.copy">copy</Translate>
                  )}
                </button>
              </div>
            </div>

            <p className={styles.meta}>
              <span>
                <Translate id="homepage.hero.meta.npm">not on npm — installs from a checkout</Translate>
              </span>
              <span aria-hidden="true"> · </span>
              <span>Node ≥ 22</span>
              <span aria-hidden="true"> · </span>
              <Link to="/docs/intro">
                <Translate id="homepage.hero.meta.docs">read the docs →</Translate>
              </Link>
              <span aria-hidden="true"> · </span>
              <a href="https://github.com/Koumalabs/caesar">
                <Translate id="homepage.hero.meta.source">read the source ↗</Translate>
              </a>
            </p>

            <dl className={styles.stats}>
              <div className={styles.stat}>
                <dd>5</dd>
                <dt>
                  <Translate id="homepage.hero.stat.providers">providers</Translate>
                </dt>
              </div>
              <div className={styles.stat}>
                <dd>16</dd>
                <dt>
                  <Translate id="homepage.hero.stat.commands">CLI commands</Translate>
                </dt>
              </div>
              <div className={styles.stat}>
                <dd>10</dd>
                <dt>
                  <Translate id="homepage.hero.stat.tools">MCP tools</Translate>
                </dt>
              </div>
              <div className={styles.stat}>
                <dd>6.3&thinsp;s</dd>
                <dt>
                  <Translate id="homepage.hero.stat.workshop">workshop clone, CoW</Translate>
                </dt>
              </div>
              <div className={styles.stat}>
                <dd>0</dd>
                <dt>
                  <Translate id="homepage.hero.stat.sdk">SDK to integrate</Translate>
                </dt>
              </div>
            </dl>
          </div>

          <div className={styles.panel} aria-hidden="true">
            <McpDemo />
            <p className={styles.panelCaption}>
              mcp · 10 tools — session abridged — oacp · fs-native
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}
