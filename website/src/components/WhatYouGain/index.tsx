import type {ReactNode} from 'react';
import clsx from 'clsx';
import Translate from '@docusaurus/Translate';
import styles from './styles.module.css';

/**
 * Three axes (Time, Risk, Cost & flexibility), each a without/with pair.
 * No number appears here beyond the one real benchmark (975 MB / 6.3 s /
 * 11 MB versus 15.0 s / 994 MB) — everything else is qualitative, on
 * purpose. Written out literally rather than from a data array: the
 * `write-translations` extraction needs a static `id` and message on every
 * `<Translate>` call site.
 */
export default function WhatYouGain(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.heading}>
          <span aria-hidden="true" className={styles.mark}>
            ▞▚
          </span>{' '}
          <Translate id="homepage.gain.title">What you gain</Translate>
        </h2>

        <div className={styles.axis}>
          <h3 className={styles.axisTitle}>
            <Translate id="homepage.gain.axis.time">Time</Translate>
          </h3>
          <div className={styles.columns}>
            <div className={styles.column}>
              <p className={styles.columnLabel}>
                <Translate id="homepage.gain.label.without">Without caesar</Translate>
              </p>
              <p className={styles.columnBody}>
                <Translate id="homepage.gain.time.without">
                  One agent at a time in your working tree; every CLI has its own mission format
                  to relearn.
                </Translate>
              </p>
            </div>
            <div className={clsx(styles.column, styles.columnWith)}>
              <p className={styles.columnLabel}>
                <Translate id="homepage.gain.label.with">With caesar</Translate>
              </p>
              <p className={styles.columnBody}>
                <Translate
                  id="homepage.gain.time.with"
                  values={{
                    maxParallel: <code>max_parallel</code>,
                    nodeModules: <code>node_modules</code>,
                  }}>
                  {
                    'N tasks in parallel ({maxParallel} slots shared across processes); one workflow for five providers; a ready-to-build workshop in seconds — 975 MB of {nodeModules} cloned in 6.3 s and 11 MB of disk with copy-on-write, versus 15.0 s and 994 MB with a plain copy.'
                  }
                </Translate>
              </p>
            </div>
          </div>
        </div>

        <div className={styles.axis}>
          <h3 className={styles.axisTitle}>
            <Translate id="homepage.gain.axis.risk">Risk</Translate>
          </h3>
          <div className={styles.columns}>
            <div className={styles.column}>
              <p className={styles.columnLabel}>
                <Translate id="homepage.gain.label.without">Without caesar</Translate>
              </p>
              <p className={styles.columnBody}>
                <Translate id="homepage.gain.risk.without">
                  The agent writes straight into your repository, and you take its word for what
                  changed.
                </Translate>
              </p>
            </div>
            <div className={clsx(styles.column, styles.columnWith)}>
              <p className={styles.columnLabel}>
                <Translate id="homepage.gain.label.with">With caesar</Translate>
              </p>
              <p className={styles.columnBody}>
                <Translate
                  id="homepage.gain.risk.with"
                  values={{
                    changesVerified: <code>changes_verified_by: &quot;git&quot;</code>,
                  }}>
                  {
                    'A disposable worktree; nothing reaches your repository before an explicit diff → apply; file changes are reconciled against git ({changesVerified}); writing in place is refused by default.'
                  }
                </Translate>
              </p>
            </div>
          </div>
        </div>

        <div className={styles.axis}>
          <h3 className={styles.axisTitle}>
            <Translate id="homepage.gain.axis.cost">Cost &amp; flexibility</Translate>
          </h3>
          <div className={styles.columns}>
            <div className={styles.column}>
              <p className={styles.columnLabel}>
                <Translate id="homepage.gain.label.without">Without caesar</Translate>
              </p>
              <p className={styles.columnBody}>
                <Translate id="homepage.gain.cost.without">
                  Locked into one provider&apos;s tool and subscription.
                </Translate>
              </p>
            </div>
            <div className={clsx(styles.column, styles.columnWith)}>
              <p className={styles.columnLabel}>
                <Translate id="homepage.gain.label.with">With caesar</Translate>
              </p>
              <p className={styles.columnBody}>
                <Translate
                  id="homepage.gain.cost.with"
                  values={{
                    models: <code>[models]</code>,
                    roleModel: <code>role.model</code>,
                  }}>
                  {
                    'Spend the quotas you already pay for, across five providers; pick the model per task or per role ({models}, {roleModel}); race providers on one objective and keep only the best diff.'
                  }
                </Translate>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
