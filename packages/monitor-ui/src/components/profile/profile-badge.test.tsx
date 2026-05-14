import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pure-logic / source-grep tests for the profile-badge toolbelt rendering
// and the plan-row agent detail toolbelt surface.
//
// No DOM environment is available in this test suite, so we verify the
// implementation through source-file checks and pure logic assertions.
// This mirrors the pattern used in sidebar.test.tsx and event-card.test.tsx.

const __dirname = dirname(fileURLToPath(import.meta.url));

const profileBadgeSource = readFileSync(resolve(__dirname, 'profile-badge.tsx'), 'utf-8');
const planRowSource = readFileSync(
  resolve(__dirname, '..', 'pipeline', 'plan-row.tsx'),
  'utf-8',
);

// ---------------------------------------------------------------------------
// profile-badge.tsx — tier toolbelt rendering
// ---------------------------------------------------------------------------

describe('profile-badge: toolbelt type extensions', () => {
  it('TierRecipeEntry includes optional toolbelt field', () => {
    expect(profileBadgeSource).toContain('toolbelt?: string');
  });

  it('ProfileConfigShape includes optional tools.toolbelts registry', () => {
    expect(profileBadgeSource).toContain('tools?:');
    expect(profileBadgeSource).toContain('toolbelts?:');
    expect(profileBadgeSource).toContain('mcpServers: string[]');
  });
});

describe('profile-badge: tier toolbelt rendering logic', () => {
  it('renders toolbelt row only when entry.toolbelt is defined', () => {
    expect(profileBadgeSource).toContain('entry.toolbelt !== undefined');
  });

  it('renders "none" badge for explicit none toolbelt', () => {
    expect(profileBadgeSource).toContain("entry.toolbelt === 'none'");
    expect(profileBadgeSource).toContain('>none<');
  });

  it('renders named toolbelt badge with server names from registry', () => {
    // Checks that it looks up servers in the toolbelts registry
    expect(profileBadgeSource).toContain('cfg.tools?.toolbelts?.[entry.toolbelt');
    expect(profileBadgeSource).toContain('.sort().join');
  });
});

// ---------------------------------------------------------------------------
// plan-row.tsx — agent detail toolbelt surface
// ---------------------------------------------------------------------------

describe('plan-row: agent detail toolbelt rendering', () => {
  it('renders toolbelt in tooltip when thread.toolbelt is defined', () => {
    expect(planRowSource).toContain('thread.toolbelt !== undefined');
  });

  it('shows "none" for null toolbelt (explicitly none selection)', () => {
    expect(planRowSource).toContain("thread.toolbelt === null ? 'none'");
  });

  it('shows toolbeltSource provenance', () => {
    expect(planRowSource).toContain('thread.toolbeltSource');
  });

  it('renders projectMcpSelection when present', () => {
    expect(planRowSource).toContain('thread.projectMcpSelection');
    expect(planRowSource).toContain('project MCP:');
  });

  it('renders sorted projectMcpServerNames when non-empty', () => {
    expect(planRowSource).toContain('thread.projectMcpServerNames');
    expect(planRowSource).toContain('servers:');
  });
});

// ---------------------------------------------------------------------------
// Pure logic: toolbelt summary derivation
// ---------------------------------------------------------------------------

describe('toolbelt summary derivation (pure logic)', () => {
  // Mirrors the derivation logic in mcp-proxy.ts profileShow handler and
  // the Pi extension renderResult for eforge_profile.

  type TierConfig = { toolbelt?: string };
  type ToolbeltRegistry = Record<string, { mcpServers: string[] }>;

  function deriveTierToolbeltLabel(
    tierCfg: TierConfig,
    registry: ToolbeltRegistry,
  ): { toolbelt: string; mcpServers: string[] } {
    const tb = tierCfg.toolbelt;
    return {
      toolbelt: tb === undefined ? 'all (default)' : tb,
      mcpServers: tb && tb !== 'none' ? [...(registry[tb]?.mcpServers ?? [])].sort() : [],
    };
  }

  it('returns all (default) and empty servers when toolbelt is omitted', () => {
    const result = deriveTierToolbeltLabel({}, {});
    expect(result.toolbelt).toBe('all (default)');
    expect(result.mcpServers).toEqual([]);
  });

  it('returns none and empty servers for toolbelt: none', () => {
    const result = deriveTierToolbeltLabel({ toolbelt: 'none' }, { 'browser-ui': { mcpServers: ['playwright'] } });
    expect(result.toolbelt).toBe('none');
    expect(result.mcpServers).toEqual([]);
  });

  it('returns named toolbelt and sorted server names from registry', () => {
    const registry: ToolbeltRegistry = {
      'browser-ui': { mcpServers: ['playwright', 'accessibility'] },
    };
    const result = deriveTierToolbeltLabel({ toolbelt: 'browser-ui' }, registry);
    expect(result.toolbelt).toBe('browser-ui');
    expect(result.mcpServers).toEqual(['accessibility', 'playwright']); // sorted
  });

  it('returns empty servers when toolbelt name not in registry', () => {
    const result = deriveTierToolbeltLabel({ toolbelt: 'missing-toolbelt' }, {});
    expect(result.toolbelt).toBe('missing-toolbelt');
    expect(result.mcpServers).toEqual([]);
  });
});
