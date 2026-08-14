import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <main>
        <h1>caesar</h1>
        <p>{siteConfig.tagline}</p>
        <Link to="/docs/intro">Read the docs</Link>
      </main>
    </Layout>
  );
}
