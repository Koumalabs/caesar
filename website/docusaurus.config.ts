import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {themes as prismThemes} from 'prism-react-renderer';

/**
 * Code blocks in the site's own grounds: gruvbox Material's warm, earthy
 * token colors (the only warm pair prism-react-renderer ships), with the
 * backgrounds swapped for the site's raised paper (light) and the same
 * near-black ink as the landing's terminal windows (dark, --caesar-accent-ink).
 */
const caesarPrismLight = {
  ...prismThemes.gruvboxMaterialLight,
  plain: {...prismThemes.gruvboxMaterialLight.plain, backgroundColor: '#f3ede0'},
};

const caesarPrismDark = {
  ...prismThemes.gruvboxMaterialDark,
  plain: {...prismThemes.gruvboxMaterialDark.plain, backgroundColor: '#1a1206'},
};

/**
 * The canonical domain, written out rather than derived. A canonical URL has
 * to be stable over years, and `VERCEL_PROJECT_PRODUCTION_URL` resolves to
 * "the shortest production custom domain" — it would silently move the day a
 * shorter domain is attached to the project.
 */
const PRODUCTION_URL = 'https://caesar.koumalabs.org';

/**
 * A preview deployment serves itself: pointing its canonical and its og:url at
 * production would have every preview claim to be the real site.
 * `VERCEL_BRANCH_URL` over `VERCEL_URL` — the branch URL is stable from one
 * push to the next, and it survives Standard Deployment Protection. Neither
 * carries the scheme. `VERCEL_ENV` is `production` | `preview` | `development`.
 */
const isVercelPreview =
  Boolean(process.env.VERCEL) && process.env.VERCEL_ENV !== 'production';
const previewHost = process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL;

const siteUrl =
  process.env.DOCUSAURUS_URL ??
  (isVercelPreview && previewHost ? `https://${previewHost}` : PRODUCTION_URL);

/**
 * Docusaurus reloads this config once per locale — `buildLocale` sets the
 * variable just before reading the site, and builds locales sequentially, so
 * there is no race. It is the officially sanctioned way to translate the site
 * config, and here it is what picks the social card written in the language of
 * the page being shared.
 */
const isFr = (process.env.DOCUSAURUS_CURRENT_LOCALE ?? 'en') === 'fr';

/**
 * The alt text of the social card. It describes the card, not the page: a
 * screen reader announcing a shared link reads this, and the page's own title
 * is already carried by og:title.
 */
const socialCardAlt = isFr
  ? "La wordmark caesar en blocs ANSI Shadow, sur fond sombre, au-dessus de la phrase « Déléguez des tâches de code à des CLI d'agents externes — en toute sécurité. »"
  : 'The caesar wordmark in ANSI Shadow blocks, on a dark ground, above the line “Delegate coding tasks to external agent CLIs — safely.”';

const config: Config = {
  title: 'caesar',
  tagline: 'Delegate coding tasks to external agent CLIs — safely.',
  favicon: 'img/favicon.svg',

  /**
   * The raster half of the icon set. Docusaurus already emits the SVG favicon
   * from `favicon` above; what it cannot express is the rest — the `.ico` that
   * crawlers and older browsers fetch, the iOS home-screen tile, and the
   * manifest. Root-absolute paths on purpose: these files sit at the root of
   * every locale build, and a locale-prefixed icon would only confuse clients
   * that fetch `/favicon.ico` without reading the HTML at all.
   */
  headTags: [
    {
      tagName: 'link',
      attributes: {rel: 'icon', href: '/favicon.ico', sizes: '16x16 32x32 48x48'},
    },
    {
      tagName: 'link',
      attributes: {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/img/apple-touch-icon.png',
      },
    },
    {tagName: 'link', attributes: {rel: 'manifest', href: '/site.webmanifest'}},
  ],

  url: siteUrl,
  baseUrl: process.env.DOCUSAURUS_BASE_URL ?? '/',

  organizationName: 'Koumalabs',
  projectName: 'caesar',
  trailingSlash: false,

  /**
   * Previews stay out of the index. Docusaurus emits `noindex, nofollow` on
   * every page AND skips the sitemap entirely when this is on. Vercel already
   * sends `X-Robots-Tag: noindex` on `*.vercel.app`, but that header does not
   * follow a preview served behind a custom domain.
   */
  noIndex: isVercelPreview,

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
        /**
         * `lastmod` is read from each source file's git history. Vercel clones
         * shallow, so pages older than the clone window simply get no
         * `<lastmod>` — an absent date, never a wrong one. Set
         * `VERCEL_DEEP_CLONE=1` on the project to have it on every page.
         */
        sitemap: {
          lastmod: 'date',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    /**
     * A relative path on purpose: Docusaurus resolves it against the site URL
     * *and* the locale's baseUrl, so the French pages point at
     * `/fr/img/og-fr.png` — `static/` is copied into every locale, so the file
     * is there. An absolute URL would pin production's card onto previews.
     *
     * It was `img/logo.svg` before, which no social platform renders: they all
     * ignore SVG, so every shared link came up without a thumbnail.
     */
    image: isFr ? 'img/og-fr.png' : 'img/og.png',
    /**
     * `SiteMetadata` spreads each entry straight into a `<meta>`, so `property`
     * works alongside `name` — which is what the `og:*` tags need, since Open
     * Graph uses `property` and Twitter uses `name`.
     */
    metadata: [
      {property: 'og:type', content: 'website'},
      {property: 'og:site_name', content: 'caesar'},
      {property: 'og:image:type', content: 'image/png'},
      {property: 'og:image:width', content: '1200'},
      {property: 'og:image:height', content: '630'},
      {property: 'og:image:alt', content: socialCardAlt},
      {name: 'twitter:image:alt', content: socialCardAlt},
      {
        name: 'keywords',
        content: isFr
          ? "caesar, agent de code, sous-agent, orchestrateur, MCP, Claude Code, Codex, OpenCode, Copilot, Antigravity, worktree git, CLI"
          : 'caesar, coding agent, sub-agent, orchestrator, MCP, Claude Code, Codex, OpenCode, Copilot, Antigravity, git worktree, CLI',
      },
    ],
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
            {
              label: 'GitHub',
              href: 'https://github.com/Koumalabs/caesar',
            },
          ],
        },
      ],
      copyright: 'caesar — orchestrator of coding sub-agents.',
    },
    prism: {
      theme: caesarPrismLight,
      darkTheme: caesarPrismDark,
      additionalLanguages: ['bash', 'json', 'toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
