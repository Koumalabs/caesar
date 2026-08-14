import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import {translate} from '@docusaurus/Translate';
import Hero from '../components/Hero';
import Pillars from '../components/Pillars';
import WhatYouGain from '../components/WhatYouGain';
import AgentsTable from '../components/AgentsTable';
import TerminalBlock from '../components/TerminalBlock';
import Quickstart from '../components/Quickstart';

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
      <main>
        <Hero />
        <Pillars />
        <WhatYouGain />
        <AgentsTable />
        <TerminalBlock />
        <Quickstart />
      </main>
    </Layout>
  );
}
