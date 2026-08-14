import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Translate from '@docusaurus/Translate';
import styles from './styles.module.css';

/**
 * The six lines of the "CAESAR" wordmark, ANSI Shadow style — copied
 * verbatim from `packages/theme/src/wordmark.ts` (`WORDMARK_LINES`), the
 * same six lines the CLI itself prints on startup. Purely decorative
 * (`aria-hidden`): the page's accessible name comes from the <h1> below,
 * not from this <pre>.
 */
const WORDMARK_LINES: readonly string[] = [
  " ██████╗ █████╗ ███████╗███████╗ █████╗ ██████╗ ",
  "██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗",
  "██║     ███████║█████╗  ███████╗███████║██████╔╝",
  "██║     ██╔══██║██╔══╝  ╚════██║██╔══██║██╔══██╗",
  "╚██████╗██║  ██║███████╗███████║██║  ██║██║  ██║",
  " ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝",
];

export default function Hero(): ReactNode {
  return (
    <header className={styles.hero}>
      <div className={`container ${styles.inner}`}>
        <pre aria-hidden="true" className={styles.wordmark}>
          {WORDMARK_LINES.map((line, i) => (
            <span
              key={i}
              className={styles.wordmarkLine}
              style={{color: `var(--caesar-ramp-${i})`}}>
              {line}
            </span>
          ))}
        </pre>
        <h1 className={styles.srOnly}>
          <Translate id="homepage.hero.title">caesar</Translate>
        </h1>
        <p className={styles.tagline}>
          <Translate id="homepage.hero.tagline">Delegate coding tasks to external agent CLIs — safely.</Translate>
        </p>
        <p className={styles.subtext}>
          <Translate id="homepage.hero.subtext">One protocol, five providers, and a disposable git worktree between them and your repo.</Translate>
        </p>
        <div className={styles.ctas}>
          <Link className="button button--primary button--lg" to="/docs/intro">
            <Translate id="homepage.hero.cta.primary">Get started</Translate>
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/docs/protocol/overview">
            <Translate id="homepage.hero.cta.secondary">The OACP protocol</Translate>
          </Link>
        </div>
      </div>
    </header>
  );
}
