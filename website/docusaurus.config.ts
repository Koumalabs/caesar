import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {themes as prismThemes} from 'prism-react-renderer';

const config: Config = {
  title: 'caesar',
  tagline: 'Delegate coding tasks to external agent CLIs — safely.',
  favicon: 'img/favicon.svg',

  url: process.env.DOCUSAURUS_URL ?? 'https://caesar.koumalabs.org',
  baseUrl: process.env.DOCUSAURUS_BASE_URL ?? '/',

  organizationName: 'Koumalabs',
  projectName: 'caesar',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'fr'],
    localeConfigs: {
      fr: {
        label: 'Français',
        htmlLang: 'fr',
      },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/docs',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    image: 'img/logo.svg',
    navbar: {
      title: 'caesar',
      logo: {
        alt: 'caesar logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          label: 'Docs',
          position: 'left',
        },
        {
          to: '/docs/protocol/overview',
          label: 'Protocol',
          position: 'left',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
        {
          href: 'https://github.com/Koumalabs/caesar',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Links',
          items: [
            {
              label: 'Docs',
              to: '/docs/intro',
            },
            {
              label: 'Protocol',
              to: '/docs/protocol/overview',
            },
          ],
        },
      ],
      copyright: 'caesar — orchestrator of coding sub-agents.',
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
