/**
 * Grep-gate: enforces that all `plan:build:decision` event construction goes
 * through `emitBuildDecision` or `emitBuildDecisionForPlan` in
 * `packages/engine/src/decisions.ts`.
 *
 * Direct yields of `{ type: 'plan:build:decision', ... }` outside that file
 * are forbidden — this test fails if any source file contains the raw literal.
 *
 * Mirrors the pattern of the `mutateState` enforcement discipline.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..');

/** Recursively collect all `.ts` and `.tsx` files under a directory. */
function collectTypeScriptFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(fullPath, files);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(fullPath);
    }
  }
  return files;
}

/** The only file permitted to contain `type: 'plan:build:decision'`. */
const ALLOWED_FILE = 'packages/engine/src/decisions.ts';

/** Literals that identify a raw decision event construction. */
const FORBIDDEN_PATTERNS = [
  "type: 'plan:build:decision'",
  'type: "plan:build:decision"',
];

describe('emitBuildDecision discipline (grep gate)', () => {
  it('only decisions.ts constructs plan:build:decision events directly', () => {
    const searchDirs = [
      join(repoRoot, 'packages'),
      join(repoRoot, 'test'),
    ];

    const allFiles: string[] = [];
    for (const dir of searchDirs) {
      try {
        if (statSync(dir).isDirectory()) {
          collectTypeScriptFiles(dir, allFiles);
        }
      } catch {
        // Directory doesn't exist — skip
      }
    }

    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const filePath of allFiles) {
      const relPath = relative(repoRoot, filePath).replace(/\\/g, '/');

      // The allowed file may contain the literal
      if (relPath === ALLOWED_FILE) continue;

      // Test files may reference the type discriminant for assertions, type
      // predicates, and test fixture construction — exempt them from this gate.
      if (
        relPath.endsWith('.test.ts') ||
        relPath.endsWith('.test.tsx') ||
        relPath.endsWith('.spec.ts') ||
        relPath.endsWith('.spec.tsx') ||
        relPath.includes('/__tests__/')
      ) {
        continue;
      }

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (line.includes(pattern)) {
            violations.push({ file: relPath, line: i + 1, text: line.trim() });
          }
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        'Forbidden raw plan:build:decision construction found.',
        'All callers must use emitBuildDecision() or emitBuildDecisionForPlan() from packages/engine/src/decisions.ts.',
        '',
        ...violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`),
      ].join('\n');
      expect.fail(message);
    }

    expect(violations).toHaveLength(0);
  });
});
