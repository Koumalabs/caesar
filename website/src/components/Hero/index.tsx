import type {ReactNode} from 'react';
import {useState} from 'react';
import Link from '@docusaurus/Link';
import Translate, {translate} from '@docusaurus/Translate';
import SectionHeader from '../SectionHeader';
import styles from './styles.module.css';

/**
 * The six lines of the "CAESAR" wordmark, ANSI Shadow style — copied
 * verbatim from `packages/theme/src/wordmark.ts` (`WORDMARK_LINES`), the
 * same six lines the CLI itself prints on startup. Purely decorative
 * (`aria-hidden`): the page's accessible name comes from the <h1>, not
 * from this <pre>.
 */
const WORDMARK_LINES: readonly string[] = [
  " ██████╗ █████╗ ███████╗███████╗ █████╗ ██████╗ ",
  "██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗",
  "██║     ███████║█████╗  ███████╗███████║██████╔╝",
  "██║     ██╔══██║██╔══╝  ╚════██║██╔══██║██╔══██╗",
  "╚██████╗██║  ██║███████╗███████║██║  ██║██║  ██║",
  " ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝",
];

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
            <span className={`${styles.corner} ${styles.cornerTl}`}>mark · ▞▚</span>
            <span className={`${styles.corner} ${styles.cornerTr}`}>ansi shadow · 6 lines</span>
            <pre className={styles.wordmark}>
              {WORDMARK_LINES.map((line, i) => (
                <span
                  key={i}
                  className={styles.wordmarkLine}
                  style={{color: `var(--caesar-ramp-${i})`}}>
                  {line}
                </span>
              ))}
            </pre>
            <span className={`${styles.corner} ${styles.cornerBl}`}>
              ramp · #EAA52E → #9F6E1F
            </span>
            <span className={`${styles.corner} ${styles.cornerBr}`}>oacp · fs-native</span>
          </div>
        </div>
      </div>
    </header>
  );
}
