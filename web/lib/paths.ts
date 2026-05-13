import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the web/ directory regardless of whether we are running under
// Next.js (webpack/turbopack bundling) or vitest (ESM, uses import.meta.url).
//
// In Next.js, modules are bundled into chunks under `.next/server/...`, so
// `import.meta.url` and `__dirname` point inside `.next/`, not the source
// tree. Prefer `process.cwd()` because both `next build` and `next start`
// run from `web/`. Fall back to `import.meta.url` (vitest / native Node ESM)
// where the source file location is preserved.
function resolveWebRoot(): string {
  const cwd = process.cwd();
  // Next.js runs with cwd = web/. Validate by confirming the content dir exists.
  if (basename(cwd) === 'web' && existsSync(join(cwd, 'content'))) {
    return cwd;
  }
  // ESM Node.js / vitest: derive from this file's URL. `lib/paths.ts` -> `web/`.
  if (typeof import.meta?.url === 'string') {
    const candidate = join(fileURLToPath(import.meta.url), '..', '..');
    if (existsSync(join(candidate, 'content'))) {
      return candidate;
    }
  }
  // Last resort: cwd. May be wrong; loaders will surface a clear ENOENT.
  return cwd;
}

export const WEB_ROOT = resolveWebRoot();
export const CONTENT_ROOT = join(WEB_ROOT, 'content');
export const DOCS_CONTENT_DIR = join(CONTENT_ROOT, 'docs');
export const REFERENCE_CONTENT_DIR = join(CONTENT_ROOT, 'reference');
