import type {ReactNode} from 'react';
import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {translate} from '@docusaurus/Translate';
import Hero from '../components/Hero';
import WhatYouGain from '../components/WhatYouGain';
import Anatomy from '../components/Anatomy';
import AgentsTable from '../components/AgentsTable';
import Quickstart from '../components/Quickstart';
import styles from './index.module.css';

import '@fontsource-variable/fraunces';
import '@fontsource-variable/fraunces/wght-italic.css';

/**
 * The structured data, on the landing only — never injected site-wide. A
 * `SoftwareApplication` repeated on all twenty documentation pages reads as
 * boilerplate to a crawler; declared once, on the page that is the product's
 * front door, it is the expected statement.
 *
 * The URLs are built from the site context rather than hardcoded, so a preview
 * deployment describes itself instead of impersonating production.
 */
function structuredData(siteUrl: string, locale: string, description: string) {
  const org = `${siteUrl}/#organization`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': org,
        name: 'Koumalabs',
        url: siteUrl,
        logo: `${siteUrl}/img/logo.svg`,
      },
      {
        '@type': 'WebSite',
        '@id': `${siteUrl}/#website`,
        name: 'caesar',
        url: siteUrl,
        inLanguage: locale,
        publisher: {'@id': org},
      },
      {
        '@type': 'SoftwareApplication',
        name: 'caesar',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux',
        url: siteUrl,
        description,
        codeRepository: 'https://github.com/Koumalabs/caesar',
        publisher: {'@id': org},
        // Free and unpriced, which schema.org expresses as a zero offer.
        offers: {'@type': 'Offer', price: '0', priceCurrency: 'EUR'},
      },
    ],
  };
}

export default function Home(): ReactNode {
  const {siteConfig, i18n} = useDocusaurusContext();
  const title = translate({
    id: 'homepage.meta.title',
    message: 'caesar — delegate coding tasks to external agent CLIs, safely',
  });
  const description = translate({
    id: 'homepage.meta.description',
    message:
      'An orchestrator that lets a coding agent delegate tasks to external agent CLIs (Codex, Antigravity, OpenCode, Copilot, Claude) over one protocol, isolated on disposable git worktrees.',
  });

  return (
    <Layout title={title} description={description}>
      <Head>
        <script type="application/ld+json">
          {JSON.stringify(
            structuredData(siteConfig.url, i18n.currentLocale, description),
          )}
        </script>
      </Head>
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
