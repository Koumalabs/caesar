import type {ReactNode} from 'react';
import Translate from '@docusaurus/Translate';
import SectionHeader from '../SectionHeader';
import styles from './styles.module.css';

/**
 * The without/with comparison, recomposed as a ledger: the "without" story
 * as prose on the left, the "with" side as four itemized entries on the
 * right. No number appears beyond the one real benchmark (975 MB / 6.3 s /
 * 11 MB versus 15.0 s / 994 MB) — everything else is qualitative, on
 * purpose, and the method line says so. Written out literally rather than
 * from a data array: the `write-translations` extraction needs a static
 * `id` and message on every `<Translate>` call site.
 */
export default function WhatYouGain(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <SectionHeader
          num="02"
          label={<Translate id="homepage.gain.title">What you gain</Translate>}
          aside={'without → with'}
        />
        <div className={styles.grid}>
          <div className={styles.copy}>
            <h2 className={styles.title}>
              <Translate
                id="homepage.gain.headline"
                values={{
                  receipts: (
                    <em className={styles.em}>
                      <Translate id="homepage.gain.headline.em">receipts included</Translate>
                    </em>
                  ),
                }}>
                {'What you gain, {receipts}.'}
              </Translate>
            </h2>
            <p className={styles.body}>
              <Translate id="homepage.gain.without">
                Without caesar: one agent at a time in your working tree, every CLI with its
                own mission format to relearn, the agent writing straight into your repository
                — and you take its word for what changed. Locked into one provider&apos;s tool
                and subscription.
              </Translate>
            </p>
          </div>

          <div className={styles.receipts}>
            <div className={styles.row}>
              <span className={styles.rowLabel}>
                <Translate id="homepage.gain.workshop.label">workshop · copy-on-write</Translate>
              </span>
              <span className={styles.rowValue}>6.3&thinsp;s</span>
              <p className={styles.rowBody}>
                <Translate
                  id="homepage.gain.workshop.body"
                  values={{nodeModules: <code>node_modules</code>}}>
                  {
                    '975 MB of {nodeModules} cloned in 6.3 s and 11 MB of disk — versus 15.0 s and 994 MB with a plain copy.'
                  }
                </Translate>
              </p>
            </div>

            <div className={styles.row}>
              <span className={styles.rowLabel}>
                <Translate id="homepage.gain.parallel.label">parallelism</Translate>
              </span>
              <span className={styles.rowValue}>
                <Translate id="homepage.gain.parallel.value">N tasks</Translate>
              </span>
              <p className={styles.rowBody}>
                <Translate
                  id="homepage.gain.parallel.body"
                  values={{maxParallel: <code>max_parallel</code>}}>
                  {
                    '{maxParallel} slots shared across processes; one workflow for five providers.'
                  }
                </Translate>
              </p>
            </div>

            <div className={styles.row}>
              <span className={styles.rowLabel}>
                <Translate id="homepage.gain.risk.label">risk</Translate>
              </span>
              <span className={styles.rowValue}>
                <Translate id="homepage.gain.risk.value">0 writes</Translate>
              </span>
              <p className={styles.rowBody}>
                <Translate
                  id="homepage.gain.risk.body"
                  values={{
                    changesVerified: <code>changes_verified_by: &quot;git&quot;</code>,
                  }}>
                  {
                    'Nothing reaches your repository before an explicit diff → apply; file changes are reconciled against git ({changesVerified}); writing in place is refused by default.'
                  }
                </Translate>
              </p>
            </div>

            <div className={styles.row}>
              <span className={styles.rowLabel}>
                <Translate id="homepage.gain.cost.label">cost · flexibility</Translate>
              </span>
              <span className={styles.rowValue}>
                <Translate id="homepage.gain.cost.value">5 quotas</Translate>
              </span>
              <p className={styles.rowBody}>
                <Translate
                  id="homepage.gain.cost.body"
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

            <p className={styles.method}>
              <Translate id="homepage.gain.method">
                method · the clone benchmark is measured in this repository (APFS
                copy-on-write); the rest is design, not marketing
              </Translate>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
