import { describe, it, expect } from 'vitest';
import {
  EFORGE_CLAUDE_CODE_PLUGIN_NAME,
  EFORGE_DISALLOWED_TOOL_PATTERNS,
  EFORGE_MCP_SERVER_NAME,
  EFORGE_PI_PACKAGE_NAME,
  isEforgePiResource,
} from '@eforge-build/engine/backends/eforge-resource-filter';

describe('eforge-resource-filter constants', () => {
  it('pins the Pi package name that ships eforge\'s extension + skills', () => {
    // This name appears in ~/.pi/agent/settings.json packages[] for pi installations
    // and must match pi-eforge/package.json. Hard-coded here so drift is caught.
    expect(EFORGE_PI_PACKAGE_NAME).toBe('@eforge-build/pi-eforge');
  });

  it('pins the Claude Code plugin + MCP server names', () => {
    // Both declared in eforge-plugin/.claude-plugin/plugin.json + .mcp.json
    expect(EFORGE_CLAUDE_CODE_PLUGIN_NAME).toBe('eforge');
    expect(EFORGE_MCP_SERVER_NAME).toBe('eforge');
  });

  it('blocks every tool on the eforge MCP server via a single glob', () => {
    expect(EFORGE_DISALLOWED_TOOL_PATTERNS).toEqual(['mcp__eforge__*']);
  });
});

describe('isEforgePiResource', () => {
  describe('published / scoped-name installs', () => {
    it('identifies resources whose sourceInfo.source equals the package name', () => {
      expect(
        isEforgePiResource({
          resolvedPath: '/some/node_modules/@eforge-build/pi-eforge/dist/extensions/eforge/index.js',
          sourceInfoSource: '@eforge-build/pi-eforge',
        }),
      ).toBe(true);
    });

    it('identifies resources when source carries a version suffix', () => {
      expect(
        isEforgePiResource({
          resolvedPath: '/tmp/cache/pkg.js',
          sourceInfoSource: '@eforge-build/pi-eforge@0.5.9',
        }),
      ).toBe(true);
    });

    it('does not false-match sibling packages in the same scope', () => {
      expect(
        isEforgePiResource({
          resolvedPath: '/some/node_modules/@eforge-build/engine/index.js',
          sourceInfoSource: '@eforge-build/engine',
        }),
      ).toBe(false);
    });
  });

  describe('local-path (dev) installs', () => {
    it('identifies resources installed from a local pi-eforge checkout (posix)', () => {
      expect(
        isEforgePiResource({
          resolvedPath: '/Users/me/projects/eforge/packages/pi-eforge/extensions/eforge/index.ts',
          sourceInfoSource: '../../projects/eforge/packages/pi-eforge',
        }),
      ).toBe(true);
    });

    it('identifies resources installed from a local pi-eforge checkout (windows)', () => {
      expect(
        isEforgePiResource({
          resolvedPath: 'C:\\dev\\eforge\\packages\\pi-eforge\\extensions\\eforge\\index.ts',
          sourceInfoSource: '..\\..\\dev\\eforge\\packages\\pi-eforge',
        }),
      ).toBe(true);
    });

    it('identifies resources when source is an absolute local path to pi-eforge', () => {
      expect(
        isEforgePiResource({
          resolvedPath: '/Users/me/projects/eforge/packages/pi-eforge/skills/eforge-plan/SKILL.md',
          sourceInfoSource: '/Users/me/projects/eforge/packages/pi-eforge',
        }),
      ).toBe(true);
    });

    it('identifies resources via resolvedPath alone when sourceInfoSource is missing', () => {
      expect(
        isEforgePiResource({
          resolvedPath: '/some/pi-eforge/extensions/eforge/index.js',
        }),
      ).toBe(true);
    });
  });

  describe('non-eforge resources', () => {
    it('keeps user-supplied skills whose path happens to contain eforge as a substring', () => {
      // The path contains `eforge` but not as a `pi-eforge` directory segment.
      expect(
        isEforgePiResource({
          resolvedPath: '/Users/me/.pi/agent/skills/my-eforge-helper/SKILL.md',
          sourceInfoSource: 'my-eforge-helper',
        }),
      ).toBe(false);
    });

    it('keeps a hypothetical sibling package named foo-pi-eforge-helpers', () => {
      // Our path check is segment-aware, not substring-based.
      expect(
        isEforgePiResource({
          resolvedPath: '/some/node_modules/foo-pi-eforge-helpers/index.js',
          sourceInfoSource: 'foo-pi-eforge-helpers',
        }),
      ).toBe(false);
    });

    it('keeps third-party pi-package resources untouched', () => {
      expect(
        isEforgePiResource({
          resolvedPath: '/some/node_modules/@acme/pi-ext/extensions/acme/index.js',
          sourceInfoSource: '@acme/pi-ext',
        }),
      ).toBe(false);
    });

    it('keeps user-global skills loaded from ~/.pi/agent/skills', () => {
      expect(
        isEforgePiResource({
          resolvedPath: '/Users/me/.pi/agent/skills/commit/SKILL.md',
          sourceInfoSource: 'local',
        }),
      ).toBe(false);
    });
  });
});
