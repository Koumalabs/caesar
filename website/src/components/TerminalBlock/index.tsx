import type {ReactNode} from 'react';
import Translate from '@docusaurus/Translate';
import styles from './styles.module.css';

/**
 * Verbatim `caesar watch` output, copied character-for-character from the
 * "Watching the sub-agents work" section of this repository's README —
 * nothing here is invented or reformatted. Colored by span: the running
 * task's bullet in `--caesar-ok`, secondary markers in `--caesar-dim`, the
 * footer hint in `--caesar-faint`, the banner mark in the literal accent
 * `#EAA52E`. This particular capture has no warning or error line, so
 * `--caesar-warn`/`--caesar-bad` have nothing to attach to here — they are
 * exercised on the docs pages that show `caesar doctor`.
 */
const LINE_HEADER = "▞▚ caesar · watch   1 active · max_parallel 4                             17:21:20";
const LINE_TASK = "● t_efb5914d codex        —            25s  inplace · write";
const LINE_OBJECTIVE = "  Write three files a.txt, b.txt and c.txt, then run 'sleep 8 && ls -1'…";
const LINE_TOOL = "  ▸ shell /bin/zsh -lc 'sleep 8 && ls -1' — 3s";
const LINE_FILES = "  ~ 3 file(s)  ·  11 event(s)";
const LINE_FOOTER = "q or Ctrl-C to quit — watching modifies nothing.";

export default function TerminalBlock(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.heading}>
          <span aria-hidden="true" className={styles.mark}>
            ▞▚
          </span>{' '}
          <Translate id="homepage.terminal.title">Watch it work</Translate>
        </h2>
        <div className={styles.window}>
          <div className={styles.titlebar}>
            <span className={styles.dots} aria-hidden="true">
              <span className={styles.dotBad} />
              <span className={styles.dotWarn} />
              <span className={styles.dotOk} />
            </span>
            <span className={styles.windowTitle}>caesar watch</span>
          </div>
          <pre className={styles.body}>
            <span className={styles.line}>
              <span className={styles.accent}>{LINE_HEADER.slice(0, 2)}</span>
              {LINE_HEADER.slice(2)}
            </span>
            <span className={styles.line} />
            <span className={styles.line}>
              <span className={styles.ok}>{LINE_TASK.slice(0, 1)}</span>
              {LINE_TASK.slice(1)}
            </span>
            <span className={styles.line}>{LINE_OBJECTIVE}</span>
            <span className={styles.line}>
              {LINE_TOOL.slice(0, 2)}
              <span className={styles.dim}>{LINE_TOOL.slice(2, 3)}</span>
              {LINE_TOOL.slice(3)}
            </span>
            <span className={styles.line}>
              {LINE_FILES.slice(0, 2)}
              <span className={styles.dim}>{LINE_FILES.slice(2, 3)}</span>
              {LINE_FILES.slice(3)}
            </span>
            <span className={styles.line} />
            <span className={styles.line}>
              <span className={styles.faint}>{LINE_FOOTER}</span>
            </span>
          </pre>
        </div>
        <p className={styles.caption}>
          <Translate id="homepage.terminal.caption">
            Unedited output from caesar watch.
          </Translate>
        </p>
      </div>
    </section>
  );
}
