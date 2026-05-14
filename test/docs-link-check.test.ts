import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLinkCheck } from '@eforge-build/docs-gen/check';

describe('docs link check', () => {
  it('finds no internal link issues in checked-in docs artifacts', async () => {
    const result = await runLinkCheck();
    if (!result.ok) {
      throw new Error(
        `Docs link issues detected:\n${result.issues
          .map((issue) => `${issue.sourceFile}: ${issue.href} — ${issue.reason}`)
          .join('\n')}`,
      );
    }
    expect(result.issues).toHaveLength(0);
  });

  it('reports missing same-file fragments with source file and fragment', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eforge-docs-link-fixture-'));
    try {
      const fixture = join(tmp, 'fixture.md');
      writeFileSync(fixture, '# Existing Heading\n\n[Broken](#missing-fragment)\n', 'utf-8');

      const result = await runLinkCheck({ files: [fixture] });
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceFile: expect.stringContaining('fixture.md'),
            href: '#missing-fragment',
            reason: expect.stringContaining('#missing-fragment'),
          }),
        ]),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('reports malformed percent-encoded fragments instead of throwing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eforge-docs-link-fixture-'));
    try {
      mkdirSync(join(tmp, 'web/lib'), { recursive: true });
      writeFileSync(join(tmp, 'web/lib/nav.ts'), 'export const DOCS_NAV: Array<{ slug: string }> = [];\n', 'utf-8');
      const fixture = join(tmp, 'fixture.md');
      writeFileSync(fixture, '# Existing Heading\n\n[Broken](#bad%zz-fragment)\n', 'utf-8');

      const result = await runLinkCheck({ repoRoot: tmp, files: [fixture] });
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceFile: expect.stringContaining('fixture.md'),
            href: '#bad%zz-fragment',
            reason: 'Malformed percent-encoding in link',
          }),
        ]),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('treats eforge.build links as internal docs links and validates fragments', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eforge-docs-link-fixture-'));
    try {
      const fixture = join(tmp, 'fixture.md');
      writeFileSync(fixture, '[Broken](https://eforge.build/docs/extensions#missing-fragment)\n', 'utf-8');

      const result = await runLinkCheck({ files: [fixture] });
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceFile: expect.stringContaining('fixture.md'),
            href: 'https://eforge.build/docs/extensions#missing-fragment',
            reason: expect.stringContaining('web/content/docs/extensions.md'),
          }),
        ]),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('reports missing DOCS_NAV content and raw mirrors', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'eforge-docs-link-mirrors-'));
    try {
      mkdirSync(join(tmp, 'web/lib'), { recursive: true });
      writeFileSync(
        join(tmp, 'web/lib/nav.ts'),
        "export const DOCS_NAV: Array<{ slug: string }> = [{ slug: 'missing-mirror' }];\n",
        'utf-8',
      );

      const result = await runLinkCheck({ repoRoot: tmp, files: [] });
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceFile: 'web/lib/nav.ts',
            href: 'web/content/docs/missing-mirror.md',
          }),
          expect.objectContaining({
            sourceFile: 'web/lib/nav.ts',
            href: 'web/public/docs/missing-mirror.md',
          }),
        ]),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
