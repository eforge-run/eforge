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
// Engine import guard — monitor-ui must not import from @eforge-build/engine
// ---------------------------------------------------------------------------

describe('No engine imports in packages/monitor-ui/src', () => {
  /**
   * All EforgeEvent wire types must be sourced from @eforge-build/client or
   * @eforge-build/client/browser. Direct imports from @eforge-build/engine
   * pull in Zod, node: modules, and other Node-only dependencies that break
   * the browser bundle.
   */
  it('no imports from @eforge-build/engine', () => {
    const sourceFiles = collectSourceFiles(monitorUiSrc);
    // Sanity: we actually scanned files (catches mis-configured path)
    expect(sourceFiles.length).toBeGreaterThan(0);

    const engineImport = /@eforge-build\/engine/;

    const violations: string[] = [];
    for (const file of sourceFiles) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        // Skip comment lines
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*')
        ) {
          return;
        }
        if (engineImport.test(line)) {
          const rel = file.slice(monitorUiSrc.length + 1);
          violations.push(`${rel}:${idx + 1}: ${trimmed}`);
        }
      });
    }

    expect(
      violations,
      `Direct @eforge-build/engine imports found — use @eforge-build/client/browser instead:\n${violations.join('\n')}`,
    ).toHaveLength(0);
  });
});
