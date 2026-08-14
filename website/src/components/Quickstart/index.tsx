import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Translate from '@docusaurus/Translate';
import SectionHeader from '../SectionHeader';
import styles from './styles.module.css';

/**
 * The commands below are real, copy-pasteable shell input — like the
 * agent binaries in AgentsTable and the terminal captures in Anatomy, they
 * stay out of `<Translate>` on purpose. The first line is the installer
 * this site serves at /install (see `website/static/install`); the rest is
 * what its launcher makes possible from any project.
 */
const COMMANDS = [
  'curl -fsSL https://caesar.koumalabs.org/install | sh',
  'cd <your-project>',
  'caesar init      # writes .caesar/config.toml + the prompts and skills',
  'caesar doctor    # which agents are installed, allowed or not',
].join('\n');

export default function Quickstart(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <SectionHeader
          num="05"
          label={<Translate id="homepage.quickstart.title">Quickstart</Translate>}
          aside={'install → init → doctor'}
        />
        <div className={styles.grid}>
          <div className={styles.copy}>
            <h2 className={styles.heading}>
              <Translate
                id="homepage.quickstart.headline"
                values={{
                  diff: (
                    <em className={styles.em}>
                      <Translate id="homepage.quickstart.headline.em">first diff</Translate>
                    </em>
                  ),
                }}>
                {'From zero to the {diff}.'}
              </Translate>
            </h2>
            <p className={styles.intro}>
              <Translate id="homepage.quickstart.intro">
                Run the installer, then point caesar at the project you want to delegate tasks
                in.
              </Translate>
            </p>
            <p className={styles.note} role="note">
              <span className={styles.noteLabel}>
                <Translate id="homepage.quickstart.note.label">Note</Translate>
              </span>{' '}
              <Translate id="homepage.quickstart.note.body">
                caesar is not published on npm yet. The installer runs it from a checkout it
                manages for you — there is nothing to install as a project dependency.
              </Translate>
            </p>
            <p className={styles.more}>
              <Link to="/docs/getting-started/installation">
                <Translate id="homepage.quickstart.more.link">
                  Read the installation guide →
                </Translate>
              </Link>
            </p>
          </div>
          <pre className={styles.code}>
            <code>{COMMANDS}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}
