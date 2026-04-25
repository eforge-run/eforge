import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Navigate from __tests__/ up to the monitor-ui src root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const monitorUiSrc = resolve(__dirname, '..');

/**
 * Collect all .ts / .tsx source files under dir, skipping __tests__ and
 * node_modules so that test fixtures don't pollute the scan.
 */
function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      collectSourceFiles(fullPath, files);
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// API route path hygiene — plan-04-monitor-ui acceptance criterion
// ---------------------------------------------------------------------------

describe('API route path hygiene in packages/monitor-ui/src', () => {
  /**
   * Grep assertion: no literal `/api/...` strings in monitor-ui source files.
   *
   * Every HTTP path must reference API_ROUTES + buildPath() from
   * @eforge-build/client so that a single rename in routes.ts propagates to
   * all callers without a search-and-replace across the UI codebase.
   *
   * Pattern: a quote character (single, double, or backtick) immediately
   * preceding `/api/`. This catches:
   *   '/api/...'
   *   "/api/..."
   *   `/api/...`   (template literal starting with a literal /api/ segment)
   *
   * It does NOT flag:
   *   `${API_ROUTES.readRecoverySidecar}?${params}`
   * because the template literal starts with `${`, not a literal `/api/`.
   */
  it('no literal /api/... strings — all paths use API_ROUTES + buildPath()', () => {
    const sourceFiles = collectSourceFiles(monitorUiSrc);
    // Sanity: we actually scanned files (catches mis-configured path)
    expect(sourceFiles.length).toBeGreaterThan(0);

    const literalApiPath = /['"`]\/api\//;

    const violations: string[] = [];
    for (const file of sourceFiles) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        // Skip comment lines — they may mention paths without being violations.
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        ) {
          return;
        }
        if (literalApiPath.test(line)) {
          const rel = file.slice(monitorUiSrc.length + 1);
          violations.push(`${rel}:${idx + 1}: ${trimmed}`);
        }
      });
    }

    expect(
      violations,
      `Hardcoded /api/... strings found — use API_ROUTES + buildPath() instead:\n${violations.join('\n')}`,
    ).toHaveLength(0);
  });
});
