# caesar website

Docusaurus 3 site for caesar's documentation, part of the pnpm workspace at the repo root.

## Locales

- **English** (`website/docs/`) is canonical.
- **French** lives in `website/i18n/fr/docusaurus-plugin-content-docs/current/`, mirroring `website/docs/` file-for-file (same filenames, same directory structure).

Any PR that changes `website/docs/**` must update the matching French file(s) in the same change, or mark the French page as stale by adding this at the top of its content:

```mdx
:::caution
This page is behind the English version.
:::
```

If a French file is missing entirely, Docusaurus falls back to rendering the English page for that route — a missing translation is never a broken link, just an English page under the `/fr/` prefix until someone translates it.

## Useful commands

Run from the repo root:

```bash
pnpm --filter website start                                    # dev server, English
pnpm --filter website exec docusaurus start --locale fr        # dev server, French
pnpm --filter website build                                    # production build, both locales
pnpm --filter website exec docusaurus write-translations --locale fr  # regenerate the French strings (code.json, navbar/footer/sidebar labels)
```

Flags go through `pnpm --filter website exec docusaurus <cmd> --flags`: with pnpm 10, the `-- --flag` form mis-forwards the `--` boundary and Docusaurus reads the flag as a positional argument.

## Raster brand assets

`static/img/og.png`, `static/img/og-fr.png`, `static/img/apple-touch-icon.png` and `static/favicon.ico` are **generated and committed**. Regenerate them from the repo root after touching the wordmark, the palette or a tagline:

```bash
pnpm run og:build     # scripts/generate-og.mjs
```

They are committed rather than built on deploy on purpose: the generator needs a native renderer, and a social card that only exists when that binary installs cleanly is a card that will one day be missing from a shared link. The script is deterministic — same sources, same bytes — so a no-op run leaves the working tree clean, and its three devDependencies (`@resvg/resvg-js`, `fontkit`, `wawoff2`) are pinned to exact versions for the same reason: a bump would rewrite the committed PNGs with no source change.

The wordmark is drawn as rectangles from `packages/theme/src/wordmark.ts`, never as text, and the script re-proves its glyph table against `assets/logo.svg` on every run — the logo is that same wordmark's "C", written by hand, so a typo in the table fails the build instead of shipping a wrong card. The rest of the text is traced to `<path>` with fontkit: resvg cannot read woff2 and ignores variable-font axes, both silently, which would otherwise set every tagline in Fraunces Black instead of the landing's 550.

The Open Graph card is picked per locale in `docusaurus.config.ts` through `DOCUSAURUS_CURRENT_LOCALE`, which Docusaurus sets once per locale build.

## Deployment

Vercel, with the project's **Root Directory set to `website/`** — which is why `vercel.json` lives here and not at the repo root.

`cleanUrls` in that file is not cosmetic. `trailingSlash: false` makes Docusaurus emit flat files (`build/docs/intro.html`, not `docs/intro/index.html`), and without `cleanUrls` Vercel serves those only at `/docs/intro.html` — every canonical URL in `sitemap.xml` answers 404. Removing it silently un-publishes the whole documentation.

Preview deployments derive their own `url` from `VERCEL_BRANCH_URL` and set `noIndex`, so they carry `noindex, nofollow`, self-referencing canonicals, and no sitemap.
