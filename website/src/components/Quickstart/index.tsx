import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Translate from '@docusaurus/Translate';
import styles from './styles.module.css';

/**
 * The commands below are real, copy-pasteable shell input — like the
 * agent binaries in AgentsTable and the output in TerminalBlock, they stay
 * out of `<Translate>` on purpose. The `git clone` and `cd` lines are an
 * addition for a from-zero quickstart; the remaining commands match
 * "Installation and first steps" in this repository's README.
 */
const COMMANDS = [
  'git clone https://github.com/Koumalabs/caesar.git',
  'cd caesar',
  'pnpm install',
  'pnpm exec tsc -b',
  'pnpm run caesar init --root <your-project>',
  'pnpm run caesar doctor --root <your-project>',
].join('\n');

export default function Quickstart(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.heading}>
          <span aria-hidden="true" className={styles.mark}>
            ▞▚
          </span>{' '}
          <Translate id="homepage.quickstart.title">Quickstart</Translate>
        </h2>
        <p className={styles.intro}>
          <Translate id="homepage.quickstart.intro">
            Clone the repository and point caesar at the project you want to delegate tasks in.
          </Translate>
        </p>
        <pre className={styles.code}>
          <code>{COMMANDS}</code>
        </pre>
        <div className={styles.note} role="note">
          <p className={styles.noteLabel}>
            <Translate id="homepage.quickstart.note.label">Note</Translate>
          </p>
          <p className={styles.noteBody}>
            <Translate id="homepage.quickstart.note.body">
              caesar is not published on npm yet. Every command above runs from a checkout of
              this repository — there is nothing to install as a project dependency.
            </Translate>
          </p>
        </div>
        <p className={styles.more}>
          <Translate id="homepage.quickstart.more">
            Full walkthrough, including troubleshooting, in the installation guide.
          </Translate>{' '}
          <Link to="/docs/getting-started/installation">
            <Translate id="homepage.quickstart.more.link">Read the installation guide</Translate>
          </Link>
        </p>
      </div>
    </section>
  );
}
