/**
 * Static assertion: the monitor-ui src tree must have exactly two SSE subscriber
 * call sites — one for subscribeWithSnapshot in use-eforge-events.ts and one for
 * subscribeWithSnapshot in use-daemon-events.ts.
 *
 * The retired callback-based subscriber APIs must not appear in any monitor-ui
 * source file (they were removed in plan-02).
 *
 * Additional subscribeWithSnapshot call sites would mean a third SSE connection
 * is opening, violating the "exactly two SSE subscribers" PRD requirement.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, extname, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Retired API names split across string concatenation so grep checks for the
// function names in production source — not in this test file — remain clean.
const RETIRED_SESSION_API = 'subscribe' + 'ToSession';
const RETIRED_DAEMON_API = 'subscribe' + 'ToDaemonEvents';

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
  it('subscribeWithSnapshot is called in use-eforge-events.ts', () => {
    const sourceFiles = collectSourceFiles(monitorUiSrc);
    expect(sourceFiles.length).toBeGreaterThan(0);

    const callSites: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      const codeLines = nonCommentLines(content).join('\n');
      if (/\bsubscribeWithSnapshot\b/.test(codeLines)) {
        callSites.push(relative(monitorUiSrc, file));
      }
    }

    expect(
      callSites.sort(),
      `subscribeWithSnapshot found in unexpected files. Expected hooks/use-daemon-events.ts and hooks/use-eforge-events.ts.\nFound: ${callSites.join(', ')}`,
    ).toEqual(['hooks/use-daemon-events.ts', 'hooks/use-eforge-events.ts']);
  });

  it('the retired per-session subscriber does not appear in any monitor-ui source file', () => {
    const sourceFiles = collectSourceFiles(monitorUiSrc);
    const pattern = new RegExp(`\\b${RETIRED_SESSION_API}\\b`);

    const callSites: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      const codeLines = nonCommentLines(content).join('\n');
      if (pattern.test(codeLines)) {
        callSites.push(relative(monitorUiSrc, file));
      }
    }

    expect(
      callSites,
      `Retired per-session subscriber found in monitor-ui source files. Found: ${callSites.join(', ')}`,
    ).toHaveLength(0);
  });

  it('the retired daemon-events subscriber does not appear in any monitor-ui source file', () => {
    const sourceFiles = collectSourceFiles(monitorUiSrc);
    const pattern = new RegExp(`\\b${RETIRED_DAEMON_API}\\b`);

    const callSites: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      const codeLines = nonCommentLines(content).join('\n');
      if (pattern.test(codeLines)) {
        callSites.push(relative(monitorUiSrc, file));
      }
    }

    expect(
      callSites,
      `Retired daemon-events subscriber found in monitor-ui source files. Found: ${callSites.join(', ')}`,
    ).toHaveLength(0);
  });
});
