/**
 * Static assertion: the monitor-ui src tree must have exactly two SSE subscriber
 * call sites — one for subscribeToSession (use-eforge-events.ts) and one for
 * subscribeToDaemonEvents (use-daemon-events.ts).
 *
 * Additional call sites would mean a third SSE connection is opening, violating
 * the "exactly two SSE subscribers" PRD requirement.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, extname, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Navigate from __tests__/ up to the monitor-ui src root.
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

/**
 * Return only the non-comment lines of a source file so that mentions of
 * function names in JSDoc / block-comment / line-comment lines do not produce
 * false positives in the scan.
 */
function nonCommentLines(content: string): string[] {
  return content.split('\n').filter((line) => {
    const trimmed = line.trim();
    return (
      !trimmed.startsWith('//') &&
      !trimmed.startsWith('*') &&
      !trimmed.startsWith('/*')
    );
  });
}

describe('SSE subscriber count (two-subscriber invariant)', () => {
  it('subscribeToSession is called only in use-eforge-events.ts', () => {
    const sourceFiles = collectSourceFiles(monitorUiSrc);
    expect(sourceFiles.length).toBeGreaterThan(0);

    const callSites: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      // Look for actual import or call in non-comment code
      const codeLines = nonCommentLines(content).join('\n');
      if (/\bsubscribeToSession\b/.test(codeLines)) {
        callSites.push(relative(monitorUiSrc, file));
      }
    }

    expect(
      callSites.sort(),
      `subscribeToSession found in unexpected files. Expected only hooks/use-eforge-events.ts.\nFound: ${callSites.join(', ')}`,
    ).toEqual(['hooks/use-eforge-events.ts']);
  });

  it('subscribeToDaemonEvents is called only in use-daemon-events.ts', () => {
    const sourceFiles = collectSourceFiles(monitorUiSrc);

    const callSites: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      const codeLines = nonCommentLines(content).join('\n');
      if (/\bsubscribeToDaemonEvents\b/.test(codeLines)) {
        callSites.push(relative(monitorUiSrc, file));
      }
    }

    expect(
      callSites.sort(),
      `subscribeToDaemonEvents found in unexpected files. Expected only hooks/use-daemon-events.ts.\nFound: ${callSites.join(', ')}`,
    ).toEqual(['hooks/use-daemon-events.ts']);
  });
});
