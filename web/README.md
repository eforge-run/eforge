# eforge web

Next.js public documentation site for `eforge.build`.

## Local development

Run from the repository root so generated reference docs are refreshed before Next.js starts:

```bash
pnpm docs:dev
```

## Production build

```bash
pnpm docs:build
```

The production build regenerates the reference docs with `@eforge-build/docs-gen`, then builds the Next.js app in `web/`.

## Vercel deployment

This repo is configured for Vercel with the root-level `vercel.json`:

- Install command: `pnpm install --frozen-lockfile`
- Build command: `pnpm docs:build`
- Output directory: `web/.next`
- Framework preset: Next.js

Create the Vercel project from the repository root (not `web/`) so the build can access the workspace package that generates the reference docs.

Suggested project settings:

- Root Directory: repository root
- Node.js version: 22.x
- Production branch: `main`
- Domain: `eforge.build`

CLI setup, if desired:

```bash
pnpm dlx vercel link
pnpm dlx vercel --prod
```

The `.vercel/` directory created by the CLI is intentionally gitignored.
