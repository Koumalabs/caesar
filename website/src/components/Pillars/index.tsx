import type {ReactNode} from 'react';
import Translate from '@docusaurus/Translate';
import styles from './styles.module.css';

/**
 * Each card is written out literally, id and message included: Docusaurus
 * extracts `<Translate>` strings for `write-translations` through a babel
 * plugin that needs a static string literal for `id` and for the message
 * — a card built from a mapped data array would hide them from it.
 */
export default function Pillars(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.heading}>
          <span aria-hidden="true" className={styles.mark}>
            ▞▚
          </span>{' '}
          <Translate id="homepage.pillars.title">Three ideas, one orchestrator</Translate>
        </h2>
        <div className={styles.grid}>
          <article className={styles.card}>
            <h3 className={styles.cardTitle}>
              <Translate id="homepage.pillars.protocol.title">
                One protocol, not five integrations
              </Translate>
            </h3>
            <p className={styles.cardBody}>
              <Translate id="homepage.pillars.protocol.body">
                OACP sits on the filesystem — a task directory, a JSON report, an event log. No
                SDK to install, no client library to keep in sync with five different CLIs.
              </Translate>
            </p>
          </article>
          <article className={styles.card}>
            <h3 className={styles.cardTitle}>
              <Translate id="homepage.pillars.workshop.title">A disposable workshop</Translate>
            </h3>
            <p className={styles.cardBody}>
              <Translate id="homepage.pillars.workshop.body">
                Every delegation gets its own disposable git worktree. Nothing touches your
                repository before an explicit diff → apply.
              </Translate>
            </p>
          </article>
          <article className={styles.card}>
            <h3 className={styles.cardTitle}>
              <Translate id="homepage.pillars.diff.title">
                The diff is the source of truth
              </Translate>
            </h3>
            <p className={styles.cardBody}>
              <Translate id="homepage.pillars.diff.body">
                What the agent declares it changed and what git diff actually observes are
                reconciled — the diff wins, never the agent&apos;s word alone.
              </Translate>
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}
