import type {ReactNode} from 'react';
import Translate from '@docusaurus/Translate';
import SectionHeader from '../SectionHeader';
import styles from './styles.module.css';

/**
 * Agent display names and binaries are technical identifiers, not prose —
 * they stay out of `<Translate>` on purpose (same convention as the
 * command names in Quickstart). Column headers and the per-row policy
 * notes are real sentences and go through `<Translate>`. The "allowed by
 * default" / "denied by default" facts below match this repository's own
 * default policy (`packages/core/src/config.ts`, `DEFAULT_POLICY`) and the
 * "Supported agents" table in the README — `claude` is the only agent
 * denied out of the box, guarded against accidental recursion; the status
 * dot in each row encodes the same fact for scanning.
 */
export default function AgentsTable(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <SectionHeader
          num="04"
          label={<Translate id="homepage.agents.title">Supported agents</Translate>}
          aside={'codex · agy · opencode · copilot · claude'}
        />
        <h2 className={styles.title}>
          <Translate id="homepage.agents.headline">Five providers, one orchestrator.</Translate>
        </h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>
                  <Translate id="homepage.agents.col.agent">Agent</Translate>
                </th>
                <th>
                  <Translate id="homepage.agents.col.binary">Binary</Translate>
                </th>
                <th>
                  <Translate id="homepage.agents.col.notes">Notes</Translate>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Codex</td>
                <td>
                  <code>codex</code>
                </td>
                <td>
                  <span className={styles.dotOk} aria-hidden="true" />
                  <Translate id="homepage.agents.codex.note">
                    allowed by default — network opens only in write mode
                  </Translate>
                </td>
              </tr>
              <tr>
                <td>Antigravity CLI</td>
                <td>
                  <code>agy</code>
                </td>
                <td>
                  <span className={styles.dotOk} aria-hidden="true" />
                  <Translate id="homepage.agents.antigravity.note">
                    allowed by default — open network
                  </Translate>
                </td>
              </tr>
              <tr>
                <td>OpenCode</td>
                <td>
                  <code>opencode</code>
                </td>
                <td>
                  <span className={styles.dotOk} aria-hidden="true" />
                  <Translate id="homepage.agents.opencode.note">
                    allowed by default — open network
                  </Translate>
                </td>
              </tr>
              <tr>
                <td>GitHub Copilot CLI</td>
                <td>
                  <code>copilot</code>
                </td>
                <td>
                  <span className={styles.dotOk} aria-hidden="true" />
                  <Translate id="homepage.agents.copilot.note">
                    allowed by default — network controllable
                  </Translate>
                </td>
              </tr>
              <tr>
                <td>Claude Code</td>
                <td>
                  <code>claude</code>
                </td>
                <td>
                  <span className={styles.dotBad} aria-hidden="true" />
                  <Translate id="homepage.agents.claude.note">
                    denied by default — recursion guard
                  </Translate>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
