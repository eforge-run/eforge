/**
 * Discipline test: Zod import allowlist.
 *
 * Greps for "from 'zod'" and "from 'zod/v4'" across all TypeScript source
 * files under packages/x/src/ directories.  Every match must appear in the explicit
 * allowlist defined below.
 *
 * Purpose: This test starts permissive — the allowlist contains every file
 * that imports Zod today.  As plan-02 and plan-03 migrate schemas to TypeBox,
 * entries are removed from the allowlist and the test tightens automatically.
 * Any new Zod import added outside the allowlist will cause an immediate
 * failure, enforcing the migration direction.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Allowlist
//
// Every file listed here is currently permitted to import from 'zod' or
// 'zod/v4'.  Remove entries as files are migrated to TypeBox.
//
// plan-03 removed: schemas.ts, harness.ts, harnesses/pi.ts, plan.ts,
//   agents/common.ts (all migrated to TypeBox in plan-03).
// plan-03 added: harnesses/claude-sdk.ts — contains the explicit TypeBox-to-Zod
//   adapter (typeboxObjectToZodRawShape) required to satisfy the Claude Agent
//   SDK's tool() registration API. Zod is isolated to this one adapter file.
// ---------------------------------------------------------------------------

const ZOD_IMPORT_ALLOWLIST: readonly string[] = [
  // eforge CLI — MCP tool integration (out of scope for plan-03)
  'packages/eforge/src/cli/mcp-proxy.ts',
  'packages/eforge/src/cli/mcp-tool-factory.ts',

  // engine — TypeBox-to-Zod adapter for Claude Agent SDK tool() registration.
  // This is the only permitted Zod import in engine source after plan-03.
  'packages/engine/src/harnesses/claude-sdk.ts',

  // engine — config and prd-queue (deferred to a follow-up PRD)
  'packages/engine/src/config.ts',
  'packages/engine/src/prd-queue.ts',

  // input — playbook + session-plan schemas (out of scope for plan-03)
  'packages/input/src/playbook.ts',
  'packages/input/src/session-plan.ts',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Patterns that identify a Zod import (with or without /v4 suffix). */
const ZOD_IMPORT_PATTERNS = [
  "from 'zod'",
  "from 'zod/v4'",
  'from "zod"',
  'from "zod/v4"',
];

/** Recursively collect all `.ts` files under a directory (excluding node_modules / dist). */
function collectTypeScriptFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Zod import allowlist (discipline gate)', () => {
  it('every Zod import under packages/**/src/**/*.ts is in the allowlist', () => {
    const packagesDir = join(repoRoot, 'packages');

    // Collect all .ts source files inside packages/*/src/
    const allSrcFiles: string[] = [];
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcDir = join(packagesDir, entry.name, 'src');
      try {
        collectTypeScriptFiles(srcDir, allSrcFiles);
      } catch {
        // No src/ directory in this package — skip
      }
    }

    const violations: Array<{ file: string; line: number; text: string }> = [];
    const allowlistSet = new Set(ZOD_IMPORT_ALLOWLIST);

    for (const filePath of allSrcFiles) {
      const relPath = relative(repoRoot, filePath).replace(/\\/g, '/');

      // Skip test files — they may use Zod for test fixture construction
      if (
        relPath.endsWith('.test.ts') ||
        relPath.endsWith('.spec.ts') ||
        relPath.includes('/__tests__/')
      ) {
        continue;
      }

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hasZodImport = ZOD_IMPORT_PATTERNS.some((p) => line.includes(p));
        if (hasZodImport && !allowlistSet.has(relPath)) {
          violations.push({ file: relPath, line: i + 1, text: line.trim() });
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        'Zod import found outside the allowlist in test/zod-import-allowlist.test.ts.',
        'Either add the file to the allowlist (if Zod is intentional) or migrate it to TypeBox.',
        '',
        ...violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`),
      ].join('\n');
      expect.fail(message);
    }

    expect(violations).toHaveLength(0);
  });

  it('allowlist contains no phantom entries (every entry actually imports Zod)', () => {
    const packagesDir = join(repoRoot, 'packages');

    const allSrcFiles: string[] = [];
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcDir = join(packagesDir, entry.name, 'src');
      try {
        collectTypeScriptFiles(srcDir, allSrcFiles);
      } catch {
        // No src/ directory — skip
      }
    }

    // Build a set of files that actually import Zod
    const actualZodFiles = new Set<string>();
    for (const filePath of allSrcFiles) {
      const relPath = relative(repoRoot, filePath).replace(/\\/g, '/');
      const content = readFileSync(filePath, 'utf-8');
      const hasZodImport = ZOD_IMPORT_PATTERNS.some((p) => content.includes(p));
      if (hasZodImport) {
        actualZodFiles.add(relPath);
      }
    }

    const phantoms = ZOD_IMPORT_ALLOWLIST.filter((entry) => !actualZodFiles.has(entry));

    if (phantoms.length > 0) {
      const message = [
        'Allowlist contains phantom entries (files that no longer import Zod).',
        'Remove these entries from the allowlist in test/zod-import-allowlist.test.ts:',
        '',
        ...phantoms.map((p) => `  ${p}`),
      ].join('\n');
      expect.fail(message);
    }

    expect(phantoms).toHaveLength(0);
  });
});
