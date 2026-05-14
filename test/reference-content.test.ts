import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readRepoFile = (path: string) => readFileSync(path, 'utf-8');

describe('plan-01 reference and raw mirror content', () => {
  it('checks in raw mirrors for extension guide pages', () => {
    for (const [source, mirror] of [
      ['web/content/docs/extensions.md', 'web/public/docs/extensions.md'],
      ['web/content/docs/extensions-api.md', 'web/public/docs/extensions-api.md'],
    ] as const) {
      expect(existsSync(mirror)).toBe(true);
      expect(readRepoFile(mirror)).toBe(readRepoFile(source));
    }
  });

  it('generates config reference sections for toolbelts and hooks in both rendered and raw targets', () => {
    for (const path of ['web/content/reference/config.md', 'web/public/reference/config.md']) {
      const raw = readRepoFile(path);
      expect(raw).toContain('## Toolbelts');
      expect(raw).toContain('## Hooks');

      const toolbeltsSection = raw.split('## Toolbelts')[1]?.split('## Hooks')[0] ?? '';
      for (const expected of ['tools.toolbelts', 'toolbelt: none', 'omitted', '.mcp.json', 'validation']) {
        expect(toolbeltsSection).toContain(expected);
      }

      const hooksSection = raw.split('## Hooks')[1]?.split('## JSON Schema')[0] ?? '';
      for (const expected of ['event', 'command', 'timeout']) {
        expect(hooksSection).toContain(expected);
      }
    }
  });

  it('surfaces extension docs in the LLM manifest', () => {
    const raw = readRepoFile('web/public/llms.txt');
    expect(raw).toContain('/docs/extensions.md');
    expect(raw).toContain('/docs/extensions-api.md');
  });

  it('uses public toolbelt documentation links in profile-new skills', () => {
    for (const path of [
      'eforge-plugin/skills/profile-new/profile-new.md',
      'packages/pi-eforge/skills/eforge-profile-new/SKILL.md',
    ]) {
      const raw = readRepoFile(path);
      expect(raw).toContain('https://eforge.build/docs/configuration#profile-toolbelts-for-ui-work');
      expect(raw).toContain('https://eforge.build/reference/config#toolbelts');
    }
  });

  it('does not reference repo-only or stale toolbelt documentation paths from public docs or profile-new skills', () => {
    const forbidden = [
      'web/content/docs/configuration.md',
      'docs/config.md#toolbelts',
      'docs/prd/profile-toolbelts.md',
    ];

    for (const path of [
      'eforge-plugin/skills/profile-new/profile-new.md',
      'packages/pi-eforge/skills/eforge-profile-new/SKILL.md',
      'web/content/docs/configuration.md',
      'web/public/docs/configuration.md',
    ]) {
      const raw = readRepoFile(path);
      for (const staleReference of forbidden) {
        expect(raw).not.toContain(staleReference);
      }
    }
  });
});
