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
