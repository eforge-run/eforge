import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { enqueuePrd, inferTitle } from '../src/engine/prd-queue.js';

// --- inferTitle ---

describe('inferTitle', () => {
  it('extracts title from first H1 heading', () => {
    expect(inferTitle('# My Feature\n\nSome content')).toBe('My Feature');
  });

  it('extracts title from H1 heading not at start of content', () => {
    expect(inferTitle('Some preamble\n\n# The Real Title\n\nBody')).toBe('The Real Title');
  });

  it('falls back to deslugified fallback slug', () => {
    expect(inferTitle('No heading here', 'my-cool-feature')).toBe('My Cool Feature');
  });

  it('strips .md from fallback slug', () => {
    expect(inferTitle('No heading', 'my-feature.md')).toBe('My Feature');
  });

  it('returns default when no heading and no fallback', () => {
    expect(inferTitle('Just some text')).toBe('Untitled PRD');
  });

  it('prefers heading over fallback slug', () => {
    expect(inferTitle('# Heading Title', 'fallback-slug')).toBe('Heading Title');
  });
});

// --- enqueuePrd ---

describe('enqueuePrd', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'eforge-enqueue-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('writes a PRD file with correct frontmatter', async () => {
    const cwd = makeTempDir();
    const result = await enqueuePrd({
      body: '## Problem\n\nSomething is broken.',
      title: 'Fix the Widget',
      queueDir: 'queue',
      cwd,
    });

    expect(result.id).toBe('fix-the-widget');
    expect(result.filePath).toBe(join(cwd, 'queue', 'fix-the-widget.md'));
    expect(result.frontmatter.title).toBe('Fix the Widget');
    expect(result.frontmatter.status).toBe('pending');
    expect(result.frontmatter.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const content = readFileSync(result.filePath, 'utf-8');
    expect(content).toContain('title: Fix the Widget');
    expect(content).toContain('status: pending');
    expect(content).toContain('## Problem');
    expect(content).toContain('Something is broken.');
  });

  it('generates slug from title', async () => {
    const cwd = makeTempDir();
    const result = await enqueuePrd({
      body: 'body',
      title: 'My Feature',
      queueDir: 'queue',
      cwd,
    });

    expect(result.id).toBe('my-feature');
    expect(basename(result.filePath)).toBe('my-feature.md');
  });

  it('handles duplicate slugs with -2, -3 suffixes', async () => {
    const cwd = makeTempDir();
    const queueDir = join(cwd, 'queue');
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, 'my-feature.md'), '---\ntitle: My Feature\n---\n\nexisting');

    const result1 = await enqueuePrd({
      body: 'second',
      title: 'My Feature',
      queueDir: 'queue',
      cwd,
    });
    expect(result1.id).toBe('my-feature-2');

    const result2 = await enqueuePrd({
      body: 'third',
      title: 'My Feature',
      queueDir: 'queue',
      cwd,
    });
    expect(result2.id).toBe('my-feature-3');
  });

  it('auto-creates queue directory', async () => {
    const cwd = makeTempDir();
    const result = await enqueuePrd({
      body: 'body',
      title: 'New PRD',
      queueDir: 'nested/queue/dir',
      cwd,
    });

    expect(result.filePath).toBe(join(cwd, 'nested', 'queue', 'dir', 'new-prd.md'));
    const content = readFileSync(result.filePath, 'utf-8');
    expect(content).toContain('title: New PRD');
  });

  it('preserves priority in frontmatter', async () => {
    const cwd = makeTempDir();
    const result = await enqueuePrd({
      body: 'body',
      title: 'High Priority',
      queueDir: 'queue',
      cwd,
      priority: 1,
    });

    expect(result.frontmatter.priority).toBe(1);
    const content = readFileSync(result.filePath, 'utf-8');
    expect(content).toContain('priority: 1');
  });

  it('preserves depends_on in frontmatter', async () => {
    const cwd = makeTempDir();
    const result = await enqueuePrd({
      body: 'body',
      title: 'Dependent PRD',
      queueDir: 'queue',
      cwd,
      depends_on: ['auth', 'database'],
    });

    expect(result.frontmatter.depends_on).toEqual(['auth', 'database']);
    const content = readFileSync(result.filePath, 'utf-8');
    expect(content).toContain('depends_on: ["auth", "database"]');
  });

  it('handles special characters in title for slug', async () => {
    const cwd = makeTempDir();
    const result = await enqueuePrd({
      body: 'body',
      title: 'Add OAuth 2.0 & SSO!',
      queueDir: 'queue',
      cwd,
    });

    expect(result.id).toBe('add-oauth-2-0-sso');
  });

  it('sets created to today ISO date', async () => {
    const cwd = makeTempDir();
    const result = await enqueuePrd({
      body: 'body',
      title: 'Test',
      queueDir: 'queue',
      cwd,
    });

    const today = new Date().toISOString().split('T')[0];
    expect(result.frontmatter.created).toBe(today);
  });
});
