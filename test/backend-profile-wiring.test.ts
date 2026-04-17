/**
 * Wiring tests for plan-02-mcp-skills-wiring.
 *
 * Plan-02 is primarily a wiring plan: MCP tools, skills, init-flow updates,
 * and a plugin version bump. Most of its verification is manual (live-daemon
 * smoke tests). These tests validate the pieces that can be checked
 * statically — file existence and shape of the registrations in the
 * consumer-facing packages (`eforge-plugin/` and `packages/pi-eforge/`), the
 * matching source-level wiring in the MCP proxy and the Pi extension, and the
 * two repo-root wiring changes (root `.gitignore` entry and the MCP proxy's
 * managed gitignore entries for the init tool).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// Resolve paths relative to the repo root (one dir up from `test/`).
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function readRepoFile(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf-8');
}

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('No YAML frontmatter found in markdown');
  }
  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Frontmatter did not parse to an object');
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugin manifest (eforge-plugin/.claude-plugin/plugin.json)
// ---------------------------------------------------------------------------

describe('eforge-plugin/.claude-plugin/plugin.json', () => {
  const manifest = JSON.parse(readRepoFile('eforge-plugin/.claude-plugin/plugin.json')) as {
    name: string;
    version: string;
    commands: string[];
  };

  it('has the plan-02 version bump (0.5.26)', () => {
    expect(manifest.version).toBe('0.5.26');
  });

  it('registers the /eforge:backend skill in commands', () => {
    expect(manifest.commands).toContain('./skills/backend/backend.md');
  });

  it('registers the /eforge:backend:new skill in commands', () => {
    expect(manifest.commands).toContain('./skills/backend-new/backend-new.md');
  });

  it('preserves the pre-existing skill entries', () => {
    // plan-02 says existing entries are left intact; we guard the core ones.
    for (const preexisting of [
      './skills/build/build.md',
      './skills/status/status.md',
      './skills/config/config.md',
      './skills/update/update.md',
      './skills/restart/restart.md',
      './skills/init/init.md',
    ]) {
      expect(manifest.commands).toContain(preexisting);
    }
  });

  it('only references skill files that actually exist on disk', () => {
    for (const cmd of manifest.commands) {
      const abs = resolve(REPO_ROOT, 'eforge-plugin', cmd);
      expect(existsSync(abs), `${cmd} must exist on disk`).toBe(true);
      expect(statSync(abs).isFile()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Repo-root .gitignore (scratch marker should never leak)
// ---------------------------------------------------------------------------

describe('repo-root .gitignore', () => {
  it('contains an `eforge/.active-backend` entry', () => {
    const contents = readRepoFile('.gitignore');
    const lines = contents.split('\n').map((l) => l.trim());
    expect(lines).toContain('eforge/.active-backend');
  });
});

// ---------------------------------------------------------------------------
// Claude Code plugin skills (eforge-plugin/skills/backend, backend-new)
// ---------------------------------------------------------------------------

describe('eforge-plugin/skills/backend/backend.md', () => {
  const path = 'eforge-plugin/skills/backend/backend.md';
  const raw = readRepoFile(path);
  const fm = parseFrontmatter(raw);

  it('has the expected description frontmatter', () => {
    expect(fm.description).toBe('List, inspect, and switch backend profiles');
  });

  it('has the expected argument-hint frontmatter', () => {
    expect(fm['argument-hint']).toBe('[name]');
  });

  it('references the MCP-namespaced eforge_backend tool', () => {
    expect(raw).toContain('mcp__eforge__eforge_backend');
  });

  it('documents both inspect (show) and switch (use) flows', () => {
    expect(raw).toMatch(/action:\s*["']show["']/);
    expect(raw).toMatch(/action:\s*["']use["']/);
  });

  it('includes a Related Skills table that mentions /eforge:backend:new', () => {
    expect(raw).toMatch(/##\s+Related Skills/);
    expect(raw).toContain('/eforge:backend:new');
  });
});

describe('eforge-plugin/skills/backend-new/backend-new.md', () => {
  const path = 'eforge-plugin/skills/backend-new/backend-new.md';
  const raw = readRepoFile(path);
  const fm = parseFrontmatter(raw);

  it('has the expected description frontmatter', () => {
    expect(fm.description).toBe('Create a new backend profile in eforge/backends/');
  });

  it('has the expected argument-hint frontmatter', () => {
    expect(fm['argument-hint']).toBe('[name]');
  });

  it('chains eforge_models (providers + list) -> eforge_backend create', () => {
    // Must reference both tools with MCP namespacing.
    expect(raw).toContain('mcp__eforge__eforge_models');
    expect(raw).toContain('mcp__eforge__eforge_backend');
    // Must mention both model actions and the create action.
    expect(raw).toMatch(/action:\s*["']providers["']/);
    expect(raw).toMatch(/action:\s*["']list["']/);
    expect(raw).toMatch(/action:\s*["']create["']/);
  });

  it('covers the activation step (eforge_backend action=use)', () => {
    expect(raw).toMatch(/action:\s*["']use["']/);
  });
});

// ---------------------------------------------------------------------------
// Pi extension skills (packages/pi-eforge/skills/eforge-backend, eforge-backend-new)
// ---------------------------------------------------------------------------

describe('packages/pi-eforge/skills/eforge-backend/SKILL.md', () => {
  const raw = readRepoFile('packages/pi-eforge/skills/eforge-backend/SKILL.md');
  const fm = parseFrontmatter(raw);

  it('has name: eforge-backend', () => {
    expect(fm.name).toBe('eforge-backend');
  });

  it('has disable-model-invocation: true (Pi convention)', () => {
    expect(fm['disable-model-invocation']).toBe(true);
  });

  it('uses bare tool names (no mcp__eforge__ prefix)', () => {
    expect(raw).not.toContain('mcp__eforge__');
    expect(raw).toMatch(/`eforge_backend`/);
  });
});

describe('packages/pi-eforge/skills/eforge-backend-new/SKILL.md', () => {
  const raw = readRepoFile('packages/pi-eforge/skills/eforge-backend-new/SKILL.md');
  const fm = parseFrontmatter(raw);

  it('has name: eforge-backend-new', () => {
    expect(fm.name).toBe('eforge-backend-new');
  });

  it('has disable-model-invocation: true (Pi convention)', () => {
    expect(fm['disable-model-invocation']).toBe(true);
  });

  it('uses bare tool names (no mcp__eforge__ prefix)', () => {
    expect(raw).not.toContain('mcp__eforge__');
    expect(raw).toMatch(/`eforge_backend`/);
    expect(raw).toMatch(/`eforge_models`/);
  });
});

// ---------------------------------------------------------------------------
// Init-skill updates in both integrations
// ---------------------------------------------------------------------------

describe('init skill updates (plugin + Pi parity)', () => {
  it('plugin /eforge:init mentions `eforge/.active-backend` and suggests /eforge:backend:new', () => {
    const raw = readRepoFile('eforge-plugin/skills/init/init.md');
    expect(raw).toContain('eforge/.active-backend');
    expect(raw).toContain('/eforge:backend:new');
  });

  it('Pi eforge-init skill mentions `eforge/.active-backend` and suggests /eforge:backend:new', () => {
    const raw = readRepoFile('packages/pi-eforge/skills/eforge-init/SKILL.md');
    expect(raw).toContain('eforge/.active-backend');
    expect(raw).toContain('/eforge:backend:new');
  });
});

// ---------------------------------------------------------------------------
// MCP proxy source (packages/eforge/src/cli/mcp-proxy.ts)
// ---------------------------------------------------------------------------

describe('MCP proxy registrations (packages/eforge/src/cli/mcp-proxy.ts)', () => {
  const source = readRepoFile('packages/eforge/src/cli/mcp-proxy.ts');

  it("registers the 'eforge_backend' tool via server.tool(...)", () => {
    expect(source).toMatch(/server\.tool\(\s*['"]eforge_backend['"]/);
  });

  it("registers the 'eforge_models' tool via server.tool(...)", () => {
    expect(source).toMatch(/server\.tool\(\s*['"]eforge_models['"]/);
  });

  it('declares the full action enum for eforge_backend (list|show|use|create|delete)', () => {
    // Find the eforge_backend registration block and verify each action literal appears.
    const idx = source.indexOf("server.tool(\n    'eforge_backend',");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 3000);
    for (const action of ['list', 'show', 'use', 'create', 'delete']) {
      expect(block).toContain(`'${action}'`);
    }
  });

  it('declares the action enum for eforge_models (providers|list)', () => {
    const idx = source.indexOf("server.tool(\n    'eforge_models',");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 2000);
    for (const action of ['providers', 'list']) {
      expect(block).toContain(`'${action}'`);
    }
    // And both backend kinds are acceptable inputs.
    expect(block).toContain("'claude-sdk'");
    expect(block).toContain("'pi'");
  });

  it('dispatches eforge_backend actions to the expected daemon endpoints', () => {
    // Each action should reach its matching REST path.
    expect(source).toContain("'/api/backend/list'");
    expect(source).toContain("'/api/backend/show'");
    expect(source).toContain("'/api/backend/use'");
    expect(source).toContain("'/api/backend/create'");
    expect(source).toMatch(/\/api\/backend\/\$\{encodeURIComponent\(name\)\}/);
  });

  it('dispatches eforge_models actions to the expected daemon endpoints', () => {
    expect(source).toMatch(/\/api\/models\/providers\?backend=/);
    expect(source).toMatch(/\/api\/models\/list\?/);
  });

  it("adds 'eforge/.active-backend' to the init tool's managed gitignore block", () => {
    // ensureGitignoreEntries(cwd, [..., 'eforge/.active-backend']) inside eforge_init.
    expect(source).toMatch(
      /ensureGitignoreEntries\([^)]*['"]eforge\/\.active-backend['"]/,
    );
  });
});

// ---------------------------------------------------------------------------
// Pi extension source (packages/pi-eforge/extensions/eforge/index.ts)
// ---------------------------------------------------------------------------

describe('Pi extension registrations (packages/pi-eforge/extensions/eforge/index.ts)', () => {
  const source = readRepoFile('packages/pi-eforge/extensions/eforge/index.ts');

  it("registers the 'eforge_backend' tool via pi.registerTool", () => {
    expect(source).toMatch(/name:\s*["']eforge_backend["']/);
  });

  it("registers the 'eforge_models' tool via pi.registerTool", () => {
    expect(source).toMatch(/name:\s*["']eforge_models["']/);
  });

  it('registers the /eforge:backend skill alias', () => {
    expect(source).toMatch(/name:\s*["']eforge:backend["']/);
    expect(source).toMatch(/skill:\s*["']eforge-backend["']/);
  });

  it('registers the /eforge:backend:new skill alias', () => {
    expect(source).toMatch(/name:\s*["']eforge:backend:new["']/);
    expect(source).toMatch(/skill:\s*["']eforge-backend-new["']/);
  });

  it('dispatches eforge_backend to the daemon via daemonRequest', () => {
    // Parity with the MCP proxy — must touch the same endpoints.
    expect(source).toContain('/api/backend/list');
    expect(source).toContain('/api/backend/show');
    expect(source).toContain('/api/backend/use');
    expect(source).toContain('/api/backend/create');
    expect(source).toMatch(/\/api\/backend\/\$\{encodeURIComponent\(name\)\}/);
  });

  it('dispatches eforge_models to the daemon via daemonRequest', () => {
    expect(source).toMatch(/\/api\/models\/providers\?backend=/);
    expect(source).toMatch(/\/api\/models\/list\?/);
  });
});
