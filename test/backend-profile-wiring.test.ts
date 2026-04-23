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
import { API_ROUTES } from '@eforge-build/client';

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
    // After the API_ROUTES migration, the source uses API_ROUTES.* constants
    // instead of literal path strings. Verify the constants are referenced.
    expect(source).toContain('API_ROUTES.backendList');
    expect(source).toContain('API_ROUTES.backendShow');
    expect(source).toContain('API_ROUTES.backendUse');
    expect(source).toContain('API_ROUTES.backendCreate');
    expect(source).toContain('API_ROUTES.backendDelete');
    // Verify the routes resolve to the correct paths via the shared constant.
    expect(API_ROUTES.backendList).toBe('/api/backend/list');
    expect(API_ROUTES.backendShow).toBe('/api/backend/show');
    expect(API_ROUTES.backendUse).toBe('/api/backend/use');
    expect(API_ROUTES.backendCreate).toBe('/api/backend/create');
    expect(API_ROUTES.backendDelete).toBe('/api/backend/:name');
  });

  it('dispatches eforge_models actions to the expected daemon endpoints', () => {
    // After the API_ROUTES migration, verify the source uses API_ROUTES constants.
    expect(source).toContain('API_ROUTES.modelProviders');
    expect(source).toContain('API_ROUTES.modelList');
    expect(API_ROUTES.modelProviders).toBe('/api/models/providers');
    expect(API_ROUTES.modelList).toBe('/api/models/list');
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

  it('registers the /eforge:backend command natively (not as skill alias)', () => {
    expect(source).toContain('"eforge:backend"');
    expect(source).toMatch(/from\s+['"]\.\/backend-commands['"]/);
  });

  it('registers the /eforge:backend:new command natively (not as skill alias)', () => {
    expect(source).toContain('"eforge:backend:new"');
    expect(source).toMatch(/from\s+['"]\.\/backend-commands['"]/);
  });

  it('dispatches eforge_backend to the daemon via daemonRequest', () => {
    // After the API_ROUTES migration, the source uses API_ROUTES.* constants.
    expect(source).toContain('API_ROUTES.backendList');
    expect(source).toContain('API_ROUTES.backendShow');
    expect(source).toContain('API_ROUTES.backendUse');
    expect(source).toContain('API_ROUTES.backendCreate');
    expect(source).toContain('API_ROUTES.backendDelete');
  });

  it('dispatches eforge_models to the daemon via daemonRequest', () => {
    expect(source).toContain('API_ROUTES.modelProviders');
    expect(source).toContain('API_ROUTES.modelList');
  });
});

// ---------------------------------------------------------------------------
// Scope field parity (MCP proxy + Pi extension)
// ---------------------------------------------------------------------------

describe('eforge_backend scope field parity', () => {
  const mcpSource = readRepoFile('packages/eforge/src/cli/mcp-proxy.ts');
  const piSource = readRepoFile('packages/pi-eforge/extensions/eforge/index.ts');

  it('MCP proxy eforge_backend schema includes a scope field accepting project, user, all', () => {
    // Find the eforge_backend registration block
    const idx = mcpSource.indexOf("server.tool(\n    'eforge_backend',");
    expect(idx).toBeGreaterThan(-1);
    const block = mcpSource.slice(idx, idx + 3000);
    // Verify scope enum includes all three values
    expect(block).toMatch(/scope:\s*z\.enum\(\[.*'project'.*'user'.*'all'.*\]\)/s);
  });

  it('Pi extension eforge_backend schema includes a scope field accepting project, user, all', () => {
    // Find the eforge_backend registration block
    const idx = piSource.indexOf('name: "eforge_backend"');
    expect(idx).toBeGreaterThan(-1);
    const block = piSource.slice(idx - 200, idx + 3000);
    // Verify scope with Type.Union containing all three literals
    expect(block).toContain('Type.Literal("project")');
    expect(block).toContain('Type.Literal("user")');
    expect(block).toContain('Type.Literal("all")');
  });

  it('MCP proxy threads scope as query param for list action', () => {
    // The list action should pass scope via URLSearchParams
    expect(mcpSource).toMatch(/params\.set\(['"]scope['"],\s*scope\)/);
  });

  it('MCP proxy threads scope in request body for use, create, delete actions', () => {
    // Extract the full eforge_backend tool block (up to the next server.tool call)
    const idx = mcpSource.indexOf("server.tool(\n    'eforge_backend',");
    expect(idx).toBeGreaterThan(-1);
    const nextTool = mcpSource.indexOf('server.tool(', idx + 1);
    const block = nextTool > idx ? mcpSource.slice(idx, nextTool) : mcpSource.slice(idx);
    // use action: useBody.scope = scope
    expect(block).toMatch(/useBody\.scope\s*=\s*scope/);
    // create and delete actions: body.scope = scope
    const scopeAssignments = block.match(/body\.scope\s*=\s*scope/g);
    expect(scopeAssignments).not.toBeNull();
    expect(scopeAssignments!.length).toBeGreaterThanOrEqual(2);
  });

  it('Pi extension threads scope as query param for list action', () => {
    // The list action should pass scope via URLSearchParams
    expect(piSource).toMatch(/params\.set\(["']scope["'],\s*scope\)/);
  });

  it('Pi extension threads scope in request body for use, create, delete actions', () => {
    // Extract the full eforge_backend tool block (from tool name to the next pi.registerTool call)
    const idx = piSource.indexOf('name: "eforge_backend"');
    expect(idx).toBeGreaterThan(-1);
    const nextTool = piSource.indexOf('pi.registerTool(', idx + 1);
    const block = nextTool > idx ? piSource.slice(idx - 200, nextTool) : piSource.slice(idx - 200);
    // use action: useBody.scope = scope
    expect(block).toMatch(/useBody\.scope\s*=\s*scope/);
    // create and delete actions: body.scope = scope
    const scopeAssignments = block.match(/body\.scope\s*=\s*scope/g);
    expect(scopeAssignments).not.toBeNull();
    expect(scopeAssignments!.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Pi extension native command modules (plan-02-native-pi-ux)
// ---------------------------------------------------------------------------

describe('Pi extension native command modules (plan-02-native-pi-ux)', () => {
  it('backend-commands.ts exists', () => {
    const path = resolve(REPO_ROOT, 'packages/pi-eforge/extensions/eforge/backend-commands.ts');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
  });

  it('config-command.ts exists', () => {
    const path = resolve(REPO_ROOT, 'packages/pi-eforge/extensions/eforge/config-command.ts');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
  });

  it('ui-helpers.ts exists', () => {
    const path = resolve(REPO_ROOT, 'packages/pi-eforge/extensions/eforge/ui-helpers.ts');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
  });

  it('index.ts imports from ./backend-commands and ./config-command', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/index.ts');
    expect(source).toMatch(/from\s+['"]\.\/backend-commands['"]/);
    expect(source).toMatch(/from\s+['"]\.\/config-command['"]/);
  });

  it('index.ts imports from ./ui-helpers (UIContext type)', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/index.ts');
    expect(source).toMatch(/from\s+['"]\.\/ui-helpers['"]/);
  });

  it('Pi skill files contain fallback notes for native commands', () => {
    const backendSkill = readRepoFile('packages/pi-eforge/skills/eforge-backend/SKILL.md');
    expect(backendSkill.toLowerCase()).toContain('fallback');
    expect(backendSkill).toContain('/eforge:backend');

    const backendNewSkill = readRepoFile('packages/pi-eforge/skills/eforge-backend-new/SKILL.md');
    expect(backendNewSkill.toLowerCase()).toContain('fallback');
    expect(backendNewSkill).toContain('/eforge:backend:new');

    const configSkill = readRepoFile('packages/pi-eforge/skills/eforge-config/SKILL.md');
    expect(configSkill.toLowerCase()).toContain('fallback');
    expect(configSkill).toContain('/eforge:config');
  });
});

// ---------------------------------------------------------------------------
// Module exports verification (plan-02-native-pi-ux)
// ---------------------------------------------------------------------------

describe('Native command module exports (plan-02-native-pi-ux)', () => {
  it('ui-helpers.ts exports showSelectOverlay', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/ui-helpers.ts');
    expect(source).toMatch(/export\s+(async\s+)?function\s+showSelectOverlay/);
  });

  it('ui-helpers.ts exports showInfoOverlay', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/ui-helpers.ts');
    expect(source).toMatch(/export\s+(async\s+)?function\s+showInfoOverlay/);
  });

  it('ui-helpers.ts exports withLoader', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/ui-helpers.ts');
    expect(source).toMatch(/export\s+(async\s+)?function\s+withLoader/);
  });

  it('ui-helpers.ts exports UIContext type', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/ui-helpers.ts');
    expect(source).toMatch(/export\s+interface\s+UIContext/);
  });

  it('backend-commands.ts exports handleBackendCommand', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/backend-commands.ts');
    expect(source).toMatch(/export\s+async\s+function\s+handleBackendCommand/);
  });

  it('backend-commands.ts exports handleBackendNewCommand', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/backend-commands.ts');
    expect(source).toMatch(/export\s+async\s+function\s+handleBackendNewCommand/);
  });

  it('config-command.ts exports handleConfigCommand', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/config-command.ts');
    expect(source).toMatch(/export\s+async\s+function\s+handleConfigCommand/);
  });
});

// ---------------------------------------------------------------------------
// Skill-forwarding removal for native commands (plan-02-native-pi-ux)
// ---------------------------------------------------------------------------

describe('Skill-forwarding removed for 3 native commands (plan-02-native-pi-ux)', () => {
  const source = readRepoFile('packages/pi-eforge/extensions/eforge/index.ts');

  it('eforge:backend is NOT in the skillCommands array', () => {
    // The skillCommands array should not contain eforge:backend
    const skillCommandsStart = source.indexOf('const skillCommands');
    expect(skillCommandsStart).toBeGreaterThan(-1);
    const skillCommandsEnd = source.indexOf('];', skillCommandsStart);
    const skillCommandsBlock = source.slice(skillCommandsStart, skillCommandsEnd);
    expect(skillCommandsBlock).not.toContain('"eforge:backend"');
    expect(skillCommandsBlock).not.toContain("'eforge:backend'");
  });

  it('eforge:backend:new is NOT in the skillCommands array', () => {
    const skillCommandsStart = source.indexOf('const skillCommands');
    const skillCommandsEnd = source.indexOf('];', skillCommandsStart);
    const skillCommandsBlock = source.slice(skillCommandsStart, skillCommandsEnd);
    expect(skillCommandsBlock).not.toContain('"eforge:backend:new"');
    expect(skillCommandsBlock).not.toContain("'eforge:backend:new'");
  });

  it('eforge:config is NOT in the skillCommands array', () => {
    const skillCommandsStart = source.indexOf('const skillCommands');
    const skillCommandsEnd = source.indexOf('];', skillCommandsStart);
    const skillCommandsBlock = source.slice(skillCommandsStart, skillCommandsEnd);
    expect(skillCommandsBlock).not.toContain('"eforge:config"');
    expect(skillCommandsBlock).not.toContain("'eforge:config'");
  });

  it('eforge:backend is registered natively via pi.registerCommand', () => {
    // Should appear as a native command registration, not in skillCommands
    expect(source).toMatch(/pi\.registerCommand\(\s*["']eforge:backend["']/);
  });

  it('eforge:backend:new is registered natively via pi.registerCommand', () => {
    expect(source).toMatch(/pi\.registerCommand\(\s*["']eforge:backend:new["']/);
  });

  it('eforge:config is registered natively via pi.registerCommand', () => {
    expect(source).toMatch(/pi\.registerCommand\(\s*["']eforge:config["']/);
  });

  it('native eforge:backend handler calls handleBackendCommand (not skill forwarding)', () => {
    // Find the native eforge:backend registration block
    const idx = source.indexOf('pi.registerCommand("eforge:backend"');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 300);
    expect(block).toContain('handleBackendCommand');
    expect(block).not.toContain('sendUserMessage');
  });

  it('native eforge:backend:new handler calls handleBackendNewCommand (not skill forwarding)', () => {
    const idx = source.indexOf('pi.registerCommand("eforge:backend:new"');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 300);
    expect(block).toContain('handleBackendNewCommand');
    expect(block).not.toContain('sendUserMessage');
  });

  it('native eforge:config handler calls handleConfigCommand (not skill forwarding)', () => {
    const idx = source.indexOf('pi.registerCommand("eforge:config"');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 300);
    expect(block).toContain('handleConfigCommand');
    expect(block).not.toContain('sendUserMessage');
  });
});

// ---------------------------------------------------------------------------
// Remaining 6 commands still use skill forwarding (plan-02-native-pi-ux)
// ---------------------------------------------------------------------------

describe('Remaining 6 commands still forward to skills (plan-02-native-pi-ux)', () => {
  const source = readRepoFile('packages/pi-eforge/extensions/eforge/index.ts');
  const skillCommandsStart = source.indexOf('const skillCommands');
  const skillCommandsEnd = source.indexOf('];', skillCommandsStart);
  const skillCommandsBlock = source.slice(skillCommandsStart, skillCommandsEnd);

  for (const cmd of ['eforge:build', 'eforge:status', 'eforge:init', 'eforge:plan', 'eforge:restart', 'eforge:update']) {
    it(`${cmd} remains in the skillCommands array`, () => {
      expect(skillCommandsBlock).toContain(`"${cmd}"`);
    });
  }

  it('skillCommands loop uses sendUserMessage for skill forwarding', () => {
    // After the skillCommands array, the for loop should use sendUserMessage
    const loopStart = source.indexOf('for (const cmd of skillCommands)');
    expect(loopStart).toBeGreaterThan(-1);
    const loopBlock = source.slice(loopStart, loopStart + 300);
    expect(loopBlock).toContain('sendUserMessage');
    expect(loopBlock).toContain('/skill:');
  });
});

// ---------------------------------------------------------------------------
// Ambient status: eforge-queue and eforge-build keys (plan-02-native-pi-ux)
// ---------------------------------------------------------------------------

describe('Ambient status keys (plan-02-native-pi-ux)', () => {
  const source = readRepoFile('packages/pi-eforge/extensions/eforge/index.ts');

  it('sets eforge-queue status key via ctx.ui.setStatus', () => {
    expect(source).toContain("setStatus('eforge-queue'");
  });

  it('sets eforge-build status key via ctx.ui.setStatus', () => {
    expect(source).toContain("setStatus('eforge-build'");
  });

  it('fetches queue count from /api/queue for ambient status', () => {
    // The refreshStatus function should call the queue route via API_ROUTES.queue
    const refreshStart = source.indexOf('async function refreshStatus');
    expect(refreshStart).toBeGreaterThan(-1);
    const refreshEnd = source.indexOf('pi.on(', refreshStart);
    const refreshBlock = source.slice(refreshStart, refreshEnd > -1 ? refreshEnd : refreshStart + 2000);
    expect(refreshBlock).toContain('API_ROUTES.queue');
  });

  it('fetches latest run status from /api/latest-run for ambient status', () => {
    const refreshStart = source.indexOf('async function refreshStatus');
    expect(refreshStart).toBeGreaterThan(-1);
    const refreshEnd = source.indexOf('pi.on(', refreshStart);
    const refreshBlock = source.slice(refreshStart, refreshEnd > -1 ? refreshEnd : refreshStart + 2000);
    expect(refreshBlock).toContain('API_ROUTES.latestRun');
  });

  it('fetches run summary for build phase/agent display', () => {
    const refreshStart = source.indexOf('async function refreshStatus');
    expect(refreshStart).toBeGreaterThan(-1);
    const refreshEnd = source.indexOf('pi.on(', refreshStart);
    const refreshBlock = source.slice(refreshStart, refreshEnd > -1 ? refreshEnd : refreshStart + 2000);
    // After the API_ROUTES migration, the source uses API_ROUTES.runSummary constant.
    expect(refreshBlock).toContain('API_ROUTES.runSummary');
  });

  it('hides eforge-queue when queue is empty (sets undefined)', () => {
    // Should set eforge-queue to undefined when queue has 0 items
    const queueStatusCalls = source.match(/setStatus\('eforge-queue',\s*undefined\)/g);
    expect(queueStatusCalls).not.toBeNull();
    expect(queueStatusCalls!.length).toBeGreaterThanOrEqual(1);
  });

  it('hides eforge-build when idle or no run (sets undefined)', () => {
    const buildStatusCalls = source.match(/setStatus\('eforge-build',\s*undefined\)/g);
    expect(buildStatusCalls).not.toBeNull();
    expect(buildStatusCalls!.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Architecture docs and README updates (plan-02-native-pi-ux)
// ---------------------------------------------------------------------------

describe('docs/architecture.md - native command mentions (plan-02-native-pi-ux)', () => {
  const raw = readRepoFile('docs/architecture.md');

  it('Pi Package section mentions "native" in the context of commands', () => {
    // Find the Pi Package section
    const piStart = raw.indexOf('### Pi Package');
    expect(piStart).toBeGreaterThan(-1);
    const nextSection = raw.indexOf('\n## ', piStart);
    const piSection = raw.slice(piStart, nextSection > -1 ? nextSection : undefined);
    expect(piSection.toLowerCase()).toContain('native');
  });

  it('Pi Package section mentions overlay commands for backend management', () => {
    const piStart = raw.indexOf('### Pi Package');
    const nextSection = raw.indexOf('\n## ', piStart);
    const piSection = raw.slice(piStart, nextSection > -1 ? nextSection : undefined);
    expect(piSection).toContain('/eforge:backend');
    expect(piSection).toContain('/eforge:backend:new');
  });

  it('Pi Package section mentions overlay commands for config', () => {
    const piStart = raw.indexOf('### Pi Package');
    const nextSection = raw.indexOf('\n## ', piStart);
    const piSection = raw.slice(piStart, nextSection > -1 ? nextSection : undefined);
    expect(piSection).toContain('/eforge:config');
  });

  it('Pi Package section is not described as purely "skill-based"', () => {
    const piStart = raw.indexOf('### Pi Package');
    const nextSection = raw.indexOf('\n## ', piStart);
    const piSection = raw.slice(piStart, nextSection > -1 ? nextSection : undefined);
    // The section should not say ALL commands are skill-based
    expect(piSection).not.toMatch(/Skill-based slash commands.*\/eforge:config/);
    expect(piSection).not.toMatch(/Skill-based slash commands.*\/eforge:backend/);
  });
});

describe('packages/pi-eforge/README.md - native command UX (plan-02-native-pi-ux)', () => {
  const raw = readRepoFile('packages/pi-eforge/README.md');

  it('mentions native commands for backend management', () => {
    expect(raw).toContain('/eforge:backend');
    expect(raw).toContain('/eforge:backend:new');
  });

  it('mentions native config command', () => {
    expect(raw).toContain('/eforge:config');
  });

  it('describes interactive overlay UX', () => {
    expect(raw.toLowerCase()).toContain('overlay');
  });

  it('mentions ambient status display', () => {
    expect(raw.toLowerCase()).toContain('ambient status');
  });

  it('distinguishes native commands from skill-based slash commands', () => {
    // Should have separate mentions of native commands vs slash commands
    expect(raw).toMatch(/Native Pi commands/i);
    expect(raw).toMatch(/Slash commands for/i);
  });
});
