import { describe, it, expect } from 'vitest';
import { loadDocPage, loadReferencePage } from '../lib/content.js';

describe('loadDocPage', () => {
  it('returns non-empty HTML for known doc slugs', async () => {
    const slugs = ['getting-started', 'concepts', 'configuration', 'extensions', 'extensions-api'];
    for (const slug of slugs) {
      const page = await loadDocPage(slug);
      expect(page.html, `Expected HTML for slug "${slug}"`).toBeTruthy();
      expect(page.html.length, `Expected non-empty HTML for slug "${slug}"`).toBeGreaterThan(0);
    }
  });

  it('throws a typed error for unknown doc slugs', async () => {
    await expect(loadDocPage('nonexistent-page-xyz')).rejects.toThrow('Page not found: nonexistent-page-xyz');
  });
});

describe('loadReferencePage', () => {
  it('returns non-empty HTML for known reference slugs', async () => {
    const slugs = ['cli', 'api', 'events', 'config', 'tools'];
    for (const slug of slugs) {
      const page = await loadReferencePage(slug);
      expect(page.html, `Expected HTML for slug "${slug}"`).toBeTruthy();
      expect(page.html.length, `Expected non-empty HTML for slug "${slug}"`).toBeGreaterThan(0);
    }
  });

  it('throws a typed error for unknown reference slugs', async () => {
    await expect(loadReferencePage('nonexistent-reference-xyz')).rejects.toThrow(
      'Page not found: nonexistent-reference-xyz',
    );
  });

  it('strips provenance HTML comments from rendered html and surfaces them separately', async () => {
    // cli.md has <!-- Generated file. Do not edit. --> provenance headers
    const page = await loadReferencePage('cli');
    // The provenance comments should not appear in html output
    expect(page.html).not.toContain('<!-- Generated file');
    expect(page.html).not.toContain('<!-- eforge version');
    // But they should be in the provenance field
    expect(page.provenance).toBeTruthy();
    expect(page.provenance).toContain('<!--');
  });
});
