import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import {translate} from '@docusaurus/Translate';
import Hero from '../components/Hero';
import WhatYouGain from '../components/WhatYouGain';
import Anatomy from '../components/Anatomy';
import AgentsTable from '../components/AgentsTable';
import Quickstart from '../components/Quickstart';
import styles from './index.module.css';

import '@fontsource-variable/fraunces';
import '@fontsource-variable/fraunces/wght-italic.css';

export default function Home(): ReactNode {
  return (
    <Layout
      title={translate({
        id: 'homepage.meta.title',
        message: 'caesar — delegate coding tasks to external agent CLIs, safely',
      })}
      description={translate({
        id: 'homepage.meta.description',
        message:
          'An orchestrator that lets a coding agent delegate tasks to external agent CLIs (Codex, Antigravity, OpenCode, Copilot, Claude) over one protocol, isolated on disposable git worktrees.',
      })}>
      <main className={styles.landing}>
        <Hero />
        <WhatYouGain />
        <Anatomy />
        <AgentsTable />
        <Quickstart />
      </main>
    </Layout>
  );
}
