import type {ReactNode} from 'react';
import styles from './styles.module.css';

/**
 * The numbered eyebrow every landing section opens with: `§ NN`, a
 * spaced-caps label, a hairline rule, and an optional right-aligned aside.
 * The numbering is real information — the landing reads as one argument,
 * in order — so it lives here once instead of being redrawn per section.
 * Label and aside arrive already translated (`<Translate>` needs static
 * literals at its call sites, so the strings stay in each section).
 */
export default function SectionHeader({
  num,
  label,
  aside,
}: {
  num: string;
  label: ReactNode;
  aside?: ReactNode;
}): ReactNode {
  return (
    <div className={styles.row}>
      <span className={styles.num}>§ {num}</span>
      <span className={styles.label}>{label}</span>
      <span className={styles.rule} aria-hidden="true" />
      {aside ? <span className={styles.aside}>{aside}</span> : null}
    </div>
  );
}
