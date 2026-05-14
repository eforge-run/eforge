/**
 * Tests for AgentRuntimeRegistry: tier-driven harness lookup, lazy Pi load,
 * toolbelt-filtered MCP server memoization, and forRoleResolved.
 */

import { describe, it, expect } from 'vitest';
import {
  singletonRegistry,
  buildAgentRuntimeRegistry,
} from '@eforge-build/engine/agent-runtime-registry';
import { StubHarness } from './stub-harness.js';
import { DEFAULT_CONFIG, resolveConfig } from '@eforge-build/engine/config';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

const FAKE_MCP: Record<string, McpServerConfig> = {
  playwright: { type: 'stdio', command: 'npx', args: ['playwright'] } as McpServerConfig,
  figma: { type: 'stdio', command: 'npx', args: ['figma-mcp'] } as McpServerConfig,
};

const FULL_TIERS_CLAUDE = {
  planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
  implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const },
  review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
  evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
} as const;

// ---------------------------------------------------------------------------
// singletonRegistry — test adapter
// ---------------------------------------------------------------------------

describe('singletonRegistry', () => {
  it('returns the same backend instance for all roles', () => {
    const stub = new StubHarness([]);
    const registry = singletonRegistry(stub);

    expect(registry.forRole('builder')).toBe(stub);
    expect(registry.forRole('planner')).toBe(stub);
    expect(registry.forRole('reviewer')).toBe(stub);
  });

  it('forRoleResolved returns harness and a default toolbelt summary', () => {
    const stub = new StubHarness([]);
    const registry = singletonRegistry(stub);

    const { harness, toolbeltSummary } = registry.forRoleResolved('builder');
    expect(harness).toBe(stub);
    expect(toolbeltSummary.toolbeltSource).toBe('default');
    expect(toolbeltSummary.projectMcpSelection).toBe('all');
    expect(Array.isArray(toolbeltSummary.projectMcpServerNames)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAgentRuntimeRegistry — tier-driven dispatch
// ---------------------------------------------------------------------------

describe('buildAgentRuntimeRegistry', () => {
  it('roles in tiers sharing harness+provider get the same instance', async () => {
    const config = resolveConfig({
      agents: { tiers: FULL_TIERS_CLAUDE },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const builder = registry.forRole('builder');
    const planner = registry.forRole('planner');
    const reviewer = registry.forRole('reviewer');

    // All claude-sdk: same memoized instance
    expect(builder).toBe(planner);
    expect(builder).toBe(reviewer);
  });

  it('tiers with different harnesses produce distinct instances', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          ...FULL_TIERS_CLAUDE,
          implementation: { harness: 'pi' as const, pi: { provider: 'openrouter' }, model: 'qwen-coder', effort: 'medium' as const },
        },
      },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const builder = registry.forRole('builder');   // pi
    const planner = registry.forRole('planner');   // claude-sdk

    expect(builder).not.toBe(planner);
  });

  it('two pi tiers with same provider share the same instance', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-sonnet-4-6', effort: 'medium' as const },
          review: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const planner = registry.forRole('planner');
    const builder = registry.forRole('builder');
    expect(planner).toBe(builder);
  });

  it('two pi tiers with different providers produce distinct instances', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'pi' as const, pi: { provider: 'openrouter' }, model: 'qwen-coder', effort: 'medium' as const },
          review: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});

    const planner = registry.forRole('planner'); // pi/anthropic
    const builder = registry.forRole('builder'); // pi/openrouter
    expect(planner).not.toBe(builder);
  });

  it('DEFAULT_CONFIG has tiers and builds registry successfully', async () => {
    const registry = await buildAgentRuntimeRegistry(DEFAULT_CONFIG, {});
    const harness = registry.forRole('builder');
    expect(harness).toBeDefined();
  });

  it('throws when tiers is empty', async () => {
    const config = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, tiers: {} } };
    await expect(buildAgentRuntimeRegistry(config, {})).rejects.toThrow(/agents.tiers/);
  });
});

// ---------------------------------------------------------------------------
// forRoleResolved — toolbelt summary
// ---------------------------------------------------------------------------

describe('buildAgentRuntimeRegistry — forRoleResolved toolbelt summary', () => {
  it('omitted toolbelt → projectMcpSelection=all with all server names', async () => {
    const config = resolveConfig({ agents: { tiers: FULL_TIERS_CLAUDE } });
    const registry = await buildAgentRuntimeRegistry(config, { mcpServers: FAKE_MCP });
    const { toolbeltSummary } = registry.forRoleResolved('builder');
    expect(toolbeltSummary.projectMcpSelection).toBe('all');
    expect(toolbeltSummary.toolbeltSource).toBe('default');
    expect(toolbeltSummary.projectMcpServerNames).toEqual(['figma', 'playwright']);
  });

  it("toolbelt: 'none' → projectMcpSelection=none with empty server list", async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          ...FULL_TIERS_CLAUDE,
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const, toolbelt: 'none' },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, { mcpServers: FAKE_MCP });
    const { toolbeltSummary } = registry.forRoleResolved('builder');
    expect(toolbeltSummary.projectMcpSelection).toBe('none');
    expect(toolbeltSummary.toolbelt).toBeNull();
    expect(toolbeltSummary.projectMcpServerNames).toEqual([]);
  });

  it('named toolbelt → projectMcpSelection=toolbelt with filtered server list', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          ...FULL_TIERS_CLAUDE,
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const, toolbelt: 'ui-tools' },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
      toolbelts: { 'ui-tools': { mcpServers: ['playwright'] } },
    });
    const { toolbeltSummary } = registry.forRoleResolved('builder');
    expect(toolbeltSummary.projectMcpSelection).toBe('toolbelt');
    expect(toolbeltSummary.toolbelt).toBe('ui-tools');
    expect(toolbeltSummary.toolbeltSource).toBe('tier');
    expect(toolbeltSummary.projectMcpServerNames).toEqual(['playwright']);
  });

  it('two pi tiers same provider different toolbelts → distinct instances with different projectMcpServerNames', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-sonnet-4-6', effort: 'medium' as const, toolbelt: 'ui-tools' },
          review: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const, toolbelt: 'none' },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
      toolbelts: { 'ui-tools': { mcpServers: ['playwright'] } },
    });

    const { harness: planH, toolbeltSummary: planTb } = registry.forRoleResolved('planner');     // all
    const { harness: implH, toolbeltSummary: implTb } = registry.forRoleResolved('builder');     // ui-tools → playwright
    const { harness: evalH, toolbeltSummary: evalTb } = registry.forRoleResolved('evaluator');   // none

    expect(planH).not.toBe(implH);
    expect(planH).not.toBe(evalH);
    expect(implH).not.toBe(evalH);

    expect(planTb.projectMcpServerNames).toEqual(['figma', 'playwright']);
    expect(implTb.projectMcpServerNames).toEqual(['playwright']);
    expect(evalTb.projectMcpServerNames).toEqual([]);
  });

  it('two claude tiers same harness different disableSubagents → distinct instances', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const, claudeSdk: { disableSubagents: true } },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, { mcpServers: FAKE_MCP });

    const { harness: planH } = registry.forRoleResolved('planner');    // disableSubagents=false
    const { harness: implH } = registry.forRoleResolved('builder');    // disableSubagents=true
    const { harness: reviewH } = registry.forRoleResolved('reviewer'); // disableSubagents=false

    expect(planH).not.toBe(implH);  // different disableSubagents
    expect(planH).toBe(reviewH);    // same disableSubagents and toolbelt
  });
});

// ---------------------------------------------------------------------------
// Pi lazy-load
// ---------------------------------------------------------------------------

describe('buildAgentRuntimeRegistry — Pi lazy-load', () => {
  it('does not import Pi when no pi tier is configured', async () => {
    const config = resolveConfig({ agents: { tiers: FULL_TIERS_CLAUDE } });
    await expect(buildAgentRuntimeRegistry(config, {})).resolves.toBeDefined();
  });

  it('lazily loads Pi when pi tiers exist', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-sonnet-4-6', effort: 'medium' as const },
          review: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'pi' as const, pi: { provider: 'anthropic' }, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });

    const registry = await buildAgentRuntimeRegistry(config, {});
    expect(registry).toBeDefined();
    expect(() => registry.forRole('planner')).not.toThrow();
  });
});
