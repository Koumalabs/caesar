import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Translate from '@docusaurus/Translate';
import SectionHeader from '../SectionHeader';
import styles from './styles.module.css';

/**
 * The three ideas of the orchestrator (protocol, workshop, verdict) plus
 * the live view, as numbered sub-sections. Every terminal capture below is
 * real output copied character-for-character from this repository's README
 * ("Real example" sections: `caesar run`, `caesar diff`/`apply`,
 * `caesar watch`) — nothing is invented or reformatted. Colored by span:
 * ✓/● in `--caesar-ok`, secondary markers in `--caesar-dim`, hints in
 * `--caesar-faint`, the banner mark in the accent gold.
 */

function TerminalWindow({title, children}: {title: string; children: ReactNode}): ReactNode {
  return (
    <div className={styles.window}>
      <div className={styles.titlebar}>
        <span className={styles.dots} aria-hidden="true">
          <span className={styles.dotBad} />
          <span className={styles.dotWarn} />
          <span className={styles.dotOk} />
        </span>
        <span className={styles.windowTitle}>{title}</span>
      </div>
      <pre className={styles.body}>{children}</pre>
    </div>
  );
}

function Line({children}: {children?: ReactNode}): ReactNode {
  return <span className={styles.line}>{children}</span>;
}

export default function Anatomy(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <SectionHeader
          num="03"
          label={<Translate id="homepage.anatomy.eyebrow">how it works</Translate>}
          aside={'protocol → workshop → verdict'}
        />
        <div className={styles.intro}>
          <h2 className={styles.title}>
            <Translate
              id="homepage.anatomy.headline"
              values={{
                judge: (
                  <em className={styles.em}>
                    <Translate id="homepage.anatomy.headline.em">git as the judge</Translate>
                  </em>
                ),
              }}>
              {'One protocol, a disposable workshop, and {judge}.'}
            </Translate>
          </h2>
          <p className={styles.introBody}>
            <Translate id="homepage.anatomy.intro">
              Three ideas carried through the whole CLI — and a live view to follow them at
              work.
            </Translate>
          </p>
        </div>

        {/* --- § 01 · protocol ------------------------------------------------ */}
        <article className={styles.sub}>
          <div className={styles.subMargin}>
            <span className={styles.subNum}>§ 01</span>
            <span className={styles.subSlug}>oacp</span>
          </div>
          <div className={styles.subMain}>
            <h3 className={styles.subTitle}>
              <Translate id="homepage.pillars.protocol.title">
                One protocol, not five integrations
              </Translate>
            </h3>
            <p className={styles.subBody}>
              <Translate id="homepage.pillars.protocol.body">
                OACP sits on the filesystem — a task directory, a JSON report, an event log. No
                SDK to install, no client library to keep in sync with five different CLIs.
              </Translate>
            </p>
            <p className={styles.subMore}>
              <Link to="/docs/protocol/overview">
                <Translate id="homepage.anatomy.protocol.more">Read the protocol →</Translate>
              </Link>
            </p>
          </div>
          <dl className={styles.specs}>
            <div className={styles.specRow}>
              <dt>surface</dt>
              <dd>
                <Translate id="homepage.anatomy.protocol.spec.surface">
                  task dir · report.json · events.ndjson
                </Translate>
              </dd>
            </div>
            <div className={styles.specRow}>
              <dt>sdk</dt>
              <dd>
                <Translate id="homepage.anatomy.protocol.spec.sdk">none — plain files</Translate>
              </dd>
            </div>
            <div className={styles.specRow}>
              <dt>channel</dt>
              <dd>
                <Translate
                  id="homepage.anatomy.protocol.spec.channel"
                  values={{flag: <code>--channel</code>}}>
                  {'MCP return channel ({flag})'}
                </Translate>
              </dd>
            </div>
          </dl>
        </article>

        {/* --- § 02 · workshop ------------------------------------------------ */}
        <article className={styles.sub}>
          <div className={styles.subMargin}>
            <span className={styles.subNum}>§ 02</span>
            <span className={styles.subSlug}>workshop</span>
          </div>
          <div className={styles.subMain}>
            <h3 className={styles.subTitle}>
              <Translate id="homepage.pillars.workshop.title">A disposable workshop</Translate>
            </h3>
            <p className={styles.subBody}>
              <Translate id="homepage.pillars.workshop.body">
                Every delegation gets its own disposable git worktree. Nothing touches your
                repository before an explicit diff → apply.
              </Translate>
            </p>
          </div>
          <dl className={styles.specs}>
            <div className={styles.specRow}>
              <dt>isolation</dt>
              <dd>worktree · inplace · auto</dd>
            </div>
            <div className={styles.specRow}>
              <dt>prepare</dt>
              <dd>
                <code>[worktree]</code> copy · link · setup
              </dd>
            </div>
            <div className={styles.specRow}>
              <dt>bench</dt>
              <dd>
                <Translate id="homepage.anatomy.workshop.spec.bench">
                  6.3 s / 11 MB, copy-on-write
                </Translate>
              </dd>
            </div>
          </dl>
          <div className={styles.demo}>
            <TerminalWindow title="caesar · run">
              <Line>
                <span className={styles.faint}>$</span> caesar run --agent codex --isolation
                worktree &quot;Create a hello.txt file containing exactly OK&quot;
              </Line>
              <Line>
                <span className={styles.accent}>▞▚</span>
                {' caesar · run ──────────────────────────────────────────────────────────────────'}
              </Line>
              <Line />
              <Line>
                {'  '}
                <span className={styles.ok}>●</span>
                {' start      agent "codex"'}
              </Line>
              <Line>
                {'  '}
                <span className={styles.dim}>▸</span>
                {' tool       shell — wc -c hello.txt && od -An -t x1 hello.txt (started)'}
              </Line>
              <Line>
                {'  '}
                <span className={styles.dim}>»</span>
                {' agent      I am creating the file with exactly two bytes, no trailing newline.'}
              </Line>
              <Line>
                {'  '}
                <span className={styles.dim}>▸</span>
                {' tool       shell — wc -c hello.txt && od -An -t x1 hello.txt (succeeded)'}
              </Line>
              <Line>
                {'  '}
                <span className={styles.dim}>~</span>
                {' file       created hello.txt'}
              </Line>
              <Line />
              <Line>
                <span className={styles.ok}>✓</span>
                {' Task t_680818a6 — status: succeeded (report "success" via "schema")'}
              </Line>
              <Line>
                {'  The hello.txt file was created with exactly the two bytes "OK", no trailing newline.'}
              </Line>
              <Line />
              <Line>{'Files modified (according to git)'}</Line>
              <Line>
                {'  '}
                <span className={styles.dim}>~</span>
                {' created hello.txt'}
              </Line>
              <Line />
              <Line>
                <span className={styles.faint}>
                  {'Isolated in a worktree: "caesar diff t_680818a6" to see the diff, "caesar apply t_680818a6" to integrate it.'}
                </span>
              </Line>
            </TerminalWindow>
            <p className={styles.caption}>
              <Translate id="homepage.anatomy.workshop.caption">
                Unedited output from caesar run.
              </Translate>
            </p>
          </div>
        </article>

        {/* --- § 03 · verdict ------------------------------------------------- */}
        <article className={styles.sub}>
          <div className={styles.subMargin}>
            <span className={styles.subNum}>§ 03</span>
            <span className={styles.subSlug}>verdict</span>
          </div>
          <div className={styles.subMain}>
            <h3 className={styles.subTitle}>
              <Translate id="homepage.pillars.diff.title">The diff is the source of truth</Translate>
            </h3>
            <p className={styles.subBody}>
              <Translate id="homepage.pillars.diff.body">
                What the agent declares it changed and what git diff actually observes are
                reconciled — the diff wins, never the agent&apos;s word alone.
              </Translate>
            </p>
          </div>
          <dl className={styles.specs}>
            <div className={styles.specRow}>
              <dt>reconcile</dt>
              <dd>
                <code>changes_verified_by: &quot;git&quot;</code>
              </dd>
            </div>
            <div className={styles.specRow}>
              <dt>integrate</dt>
              <dd>
                <Translate id="homepage.anatomy.verdict.spec.integrate">
                  diff → apply, explicit
                </Translate>
              </dd>
            </div>
            <div className={styles.specRow}>
              <dt>in-place</dt>
              <dd>
                <Translate id="homepage.anatomy.verdict.spec.inplace">
                  refused by default
                </Translate>
              </dd>
            </div>
          </dl>
          <div className={styles.demo}>
            <TerminalWindow title="caesar · diff → apply">
              <Line>
                <span className={styles.faint}>$</span>
                {' caesar diff t_680818a6a92047a2b08bb904e46d8427'}
              </Line>
              <Line>
                <span className={styles.dim}>{'diff --git a/hello.txt b/hello.txt'}</span>
              </Line>
              <Line>
                <span className={styles.dim}>{'new file mode 100644'}</span>
              </Line>
              <Line>
                <span className={styles.dim}>{'index 0000000..a0aba93'}</span>
              </Line>
              <Line>
                <span className={styles.dim}>{'--- /dev/null'}</span>
              </Line>
              <Line>
                <span className={styles.dim}>{'+++ b/hello.txt'}</span>
              </Line>
              <Line>
                <span className={styles.dim}>{'@@ -0,0 +1 @@'}</span>
              </Line>
              <Line>
                <span className={styles.ok}>{'+OK'}</span>
              </Line>
              <Line>
                <span className={styles.faint}>{'\\ No newline at end of file'}</span>
              </Line>
              <Line />
              <Line>
                <span className={styles.faint}>$</span>
                {' caesar apply t_680818a6a92047a2b08bb904e46d8427'}
              </Line>
              <Line>{'Task "t_680818a6a92047a2b08bb904e46d8427" applied to the main repository.'}</Line>
            </TerminalWindow>
            <p className={styles.caption}>
              <Translate id="homepage.anatomy.verdict.caption">
                Unedited output from caesar diff, then caesar apply.
              </Translate>
            </p>
          </div>
        </article>

        {/* --- § 04 · follow -------------------------------------------------- */}
        <article className={styles.sub}>
          <div className={styles.subMargin}>
            <span className={styles.subNum}>§ 04</span>
            <span className={styles.subSlug}>follow</span>
          </div>
          <div className={styles.subMain}>
            <h3 className={styles.subTitle}>
              <Translate id="homepage.terminal.title">Watch it work</Translate>
            </h3>
            <p className={styles.subBody}>
              <Translate id="homepage.anatomy.follow.body">
                A live view of every running delegation — the tool appears as soon as it
                starts, and what the agent says is displayed as it streams. Watching modifies
                nothing.
              </Translate>
            </p>
          </div>
          <dl className={styles.specs}>
            <div className={styles.specRow}>
              <dt>slots</dt>
              <dd>
                <Translate
                  id="homepage.anatomy.follow.spec.slots"
                  values={{maxParallel: <code>max_parallel</code>}}>
                  {'{maxParallel}, shared across processes'}
                </Translate>
              </dd>
            </div>
            <div className={styles.specRow}>
              <dt>follow</dt>
              <dd>watch · status · logs</dd>
            </div>
          </dl>
          <div className={styles.demo}>
            <TerminalWindow title="caesar · watch">
              <Line>
                <span className={styles.accent}>▞▚</span>
                {' caesar · watch   1 active · max_parallel 4                             17:21:20'}
              </Line>
              <Line />
              <Line>
                <span className={styles.ok}>●</span>
                {' t_efb5914d codex        —            25s  inplace · write'}
              </Line>
              <Line>{"  Write three files a.txt, b.txt and c.txt, then run 'sleep 8 && ls -1'…"}</Line>
              <Line>
                {'  '}
                <span className={styles.dim}>▸</span>
                {" shell /bin/zsh -lc 'sleep 8 && ls -1' — 3s"}
              </Line>
              <Line>
                {'  '}
                <span className={styles.dim}>~</span>
                {' 3 file(s)  ·  11 event(s)'}
              </Line>
              <Line />
              <Line>
                <span className={styles.faint}>
                  {'q or Ctrl-C to quit — watching modifies nothing.'}
                </span>
              </Line>
            </TerminalWindow>
            <p className={styles.caption}>
              <Translate id="homepage.terminal.caption">
                Unedited output from caesar watch.
              </Translate>
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}
