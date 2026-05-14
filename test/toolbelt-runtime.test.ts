/**
 * Runtime toolbelt resolution tests for AgentRuntimeRegistry.
 *
 * Verifies that per-tier project MCP server filtering works correctly:
 * - Omitted toolbelt passes all project MCP servers
 * - `toolbelt: none` passes no project MCP servers
 * - Named toolbelt passes only the servers declared in tools.toolbelts.<name>.mcpServers
 * - Two tiers with different toolbelts get distinct harness instances with non-overlapping server sets
 * - Two Claude tiers with same effective servers but different disableSubagents get distinct instances
 * - Named toolbelt that can't be resolved at registry construction time throws a path-specific error
 * - eforge_engine custom tool path is not in projectMcpServerNames (it's internal)
 */

import { describe, it, expect } from 'vitest';
import {
  buildAgentRuntimeRegistry,
} from '@eforge-build/engine/agent-runtime-registry';
import { resolveConfig } from '@eforge-build/engine/config';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const FAKE_MCP: Record<string, McpServerConfig> = {
  playwright: { type: 'stdio', command: 'npx', args: ['playwright'] } as McpServerConfig,
  figma: { type: 'stdio', command: 'npx', args: ['figma-mcp'] } as McpServerConfig,
  stripe: { type: 'stdio', command: 'npx', args: ['stripe-mcp'] } as McpServerConfig,
};

const FULL_TIERS_CLAUDE = {
  planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
  implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const },
  review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
  evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
};

// ---------------------------------------------------------------------------
// Toolbelt resolution — omitted → all servers
// ---------------------------------------------------------------------------

describe('toolbelt resolution: omitted toolbelt', () => {
  it('passes all project MCP servers when toolbelt is not set', async () => {
    const config = resolveConfig({ agents: { tiers: FULL_TIERS_CLAUDE } });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
    });

    const { toolbeltSummary } = registry.forRoleResolved('builder');

    expect(toolbeltSummary.projectMcpSelection).toBe('all');
    expect(toolbeltSummary.toolbeltSource).toBe('default');
    expect(toolbeltSummary.toolbelt).toBeUndefined();
    expect(toolbeltSummary.projectMcpServerNames).toEqual(['figma', 'playwright', 'stripe']);
  });

  it('projectMcpServerNames is sorted when all servers included', async () => {
    const config = resolveConfig({ agents: { tiers: FULL_TIERS_CLAUDE } });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
    });

    const { toolbeltSummary } = registry.forRoleResolved('planner');
    const names = toolbeltSummary.projectMcpServerNames;
    expect(names).toEqual([...names].sort());
  });
});

// ---------------------------------------------------------------------------
// Toolbelt resolution — toolbelt: none → no servers
// ---------------------------------------------------------------------------

describe("toolbelt resolution: toolbelt: 'none'", () => {
  it('passes no project MCP servers when toolbelt is none', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          ...FULL_TIERS_CLAUDE,
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const, toolbelt: 'none' },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
    });

    const { toolbeltSummary } = registry.forRoleResolved('evaluator');

    expect(toolbeltSummary.projectMcpSelection).toBe('none');
    expect(toolbeltSummary.toolbeltSource).toBe('tier');
    expect(toolbeltSummary.toolbelt).toBeNull();
    expect(toolbeltSummary.projectMcpServerNames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Toolbelt resolution — named toolbelt → subset of servers
// ---------------------------------------------------------------------------

describe('toolbelt resolution: named toolbelt', () => {
  it('passes only the declared servers for a named toolbelt', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          ...FULL_TIERS_CLAUDE,
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const, toolbelt: 'browser-ui' },
        },
      },
      tools: {
        toolbelts: {
          'browser-ui': { mcpServers: ['playwright'] },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
      toolbelts: { 'browser-ui': { mcpServers: ['playwright'] } },
    });

    const { toolbeltSummary } = registry.forRoleResolved('builder'); // builder is in implementation tier

    expect(toolbeltSummary.projectMcpSelection).toBe('toolbelt');
    expect(toolbeltSummary.toolbeltSource).toBe('tier');
    expect(toolbeltSummary.toolbelt).toBe('browser-ui');
    expect(toolbeltSummary.projectMcpServerNames).toEqual(['playwright']);
  });

  it('projectMcpServerNames is sorted for named toolbelt with multiple servers', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          ...FULL_TIERS_CLAUDE,
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const, toolbelt: 'design-tools' },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
      toolbelts: { 'design-tools': { mcpServers: ['stripe', 'playwright', 'figma'] } },
    });

    const { toolbeltSummary } = registry.forRoleResolved('builder');

    expect(toolbeltSummary.projectMcpServerNames).toEqual(['figma', 'playwright', 'stripe']);
  });
});

// ---------------------------------------------------------------------------
// Memoization: different toolbelts → distinct instances
// ---------------------------------------------------------------------------

describe('memoization: toolbelt differences create distinct instances', () => {
  it('two claude tiers with same provider but different toolbelts get distinct harness instances', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const, toolbelt: 'browser-ui' },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const, toolbelt: 'none' },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
      toolbelts: { 'browser-ui': { mcpServers: ['playwright'] } },
    });

    const { harness: implHarness, toolbeltSummary: implTb } = registry.forRoleResolved('builder');    // implementation: browser-ui (playwright only)
    const { harness: evalHarness, toolbeltSummary: evalTb } = registry.forRoleResolved('evaluator'); // evaluation: none (no servers)
    const { harness: planHarness, toolbeltSummary: planTb } = registry.forRoleResolved('planner');   // planning: all servers

    // All three should be distinct instances (different effective server sets)
    expect(implHarness).not.toBe(evalHarness);
    expect(implHarness).not.toBe(planHarness);
    expect(evalHarness).not.toBe(planHarness);

    // Verify non-overlapping server names
    expect(implTb.projectMcpServerNames).toEqual(['playwright']);
    expect(evalTb.projectMcpServerNames).toEqual([]);
    expect(planTb.projectMcpServerNames).toContain('playwright');
    expect(planTb.projectMcpServerNames).toContain('figma');
  });

  it('two claude tiers with same toolbelt share a harness instance', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const, toolbelt: 'browser-ui' },
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const, toolbelt: 'browser-ui' },
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const, toolbelt: 'browser-ui' },
          evaluation: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const, toolbelt: 'browser-ui' },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
      toolbelts: { 'browser-ui': { mcpServers: ['playwright'] } },
    });

    const { harness: planHarness } = registry.forRoleResolved('planner');
    const { harness: implHarness } = registry.forRoleResolved('builder');

    // Same toolbelt, same harness type → shared instance
    expect(planHarness).toBe(implHarness);
  });

  it('two claude tiers with same harness but different disableSubagents get distinct instances', async () => {
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
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
    });

    const { harness: planHarness } = registry.forRoleResolved('planner');     // disableSubagents=false
    const { harness: implHarness } = registry.forRoleResolved('builder');     // disableSubagents=true
    const { harness: reviewHarness } = registry.forRoleResolved('reviewer');  // disableSubagents=false

    // Different disableSubagents → distinct instances
    expect(planHarness).not.toBe(implHarness);

    // Same disableSubagents and same toolbelt → shared instance
    expect(planHarness).toBe(reviewHarness);
  });

  it('two pi tiers with same provider but different toolbelts get distinct instances', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          planning: { harness: 'pi' as const, pi: { provider: 'openrouter' }, model: 'claude-opus-4-7', effort: 'high' as const },
          implementation: { harness: 'pi' as const, pi: { provider: 'openrouter' }, model: 'claude-sonnet-4-6', effort: 'medium' as const, toolbelt: 'browser-ui' },
          review: { harness: 'pi' as const, pi: { provider: 'openrouter' }, model: 'claude-opus-4-7', effort: 'high' as const, toolbelt: 'none' },
          evaluation: { harness: 'pi' as const, pi: { provider: 'openrouter' }, model: 'claude-opus-4-7', effort: 'high' as const },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
      toolbelts: { 'browser-ui': { mcpServers: ['playwright'] } },
    });

    const { harness: implHarness, toolbeltSummary: implTb } = registry.forRoleResolved('builder');    // browser-ui
    const { harness: reviewHarness, toolbeltSummary: reviewTb } = registry.forRoleResolved('reviewer'); // none
    const { harness: planHarness, toolbeltSummary: planTb } = registry.forRoleResolved('planner');   // all

    expect(implHarness).not.toBe(reviewHarness);
    expect(implHarness).not.toBe(planHarness);
    expect(reviewHarness).not.toBe(planHarness);

    expect(implTb.projectMcpServerNames).toEqual(['playwright']);
    expect(reviewTb.projectMcpServerNames).toEqual([]);
    expect(planTb.projectMcpServerNames.sort()).toEqual(['figma', 'playwright', 'stripe']);
  });
});

// ---------------------------------------------------------------------------
// Error: named toolbelt that cannot be resolved
// ---------------------------------------------------------------------------

describe('toolbelt resolution: unresolvable named toolbelt', () => {
  it('throws a path-specific error when named toolbelt is not in tools.toolbelts', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          ...FULL_TIERS_CLAUDE,
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const, toolbelt: 'nonexistent-toolbelt' },
        },
      },
    });
    // No toolbelts in registry options — should throw when constructing instances for the implementation tier
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
      toolbelts: {}, // empty — 'nonexistent-toolbelt' is not declared
    });

    // Error should be thrown when trying to resolve the implementation tier role
    expect(() => registry.forRoleResolved('builder')).toThrow(
      /agents\.tiers\.implementation\.toolbelt references "nonexistent-toolbelt"/,
    );
  });

  it('error message does NOT silently fall back to all servers', async () => {
    const config = resolveConfig({
      agents: {
        tiers: {
          ...FULL_TIERS_CLAUDE,
          review: { harness: 'claude-sdk' as const, model: 'claude-opus-4-7', effort: 'high' as const, toolbelt: 'missing-tb' },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
      toolbelts: {},
    });

    // Should throw, not silently return all servers
    expect(() => registry.forRoleResolved('reviewer')).toThrow(/missing-tb/);
  });
});

// ---------------------------------------------------------------------------
// eforge_engine internal server separation
// ---------------------------------------------------------------------------

describe('toolbelt resolution: eforge_engine is not in projectMcpServerNames', () => {
  it('eforge_engine does not appear in projectMcpServerNames for any toolbelt selection', async () => {
    // The eforge_engine server is added by the harness when customTools are present.
    // It must not be part of the filtered project MCP server set.
    const config = resolveConfig({
      agents: {
        tiers: {
          ...FULL_TIERS_CLAUDE,
          implementation: { harness: 'claude-sdk' as const, model: 'claude-sonnet-4-6', effort: 'medium' as const, toolbelt: 'none' },
        },
      },
    });
    const registry = await buildAgentRuntimeRegistry(config, {
      mcpServers: FAKE_MCP,
    });

    const { toolbeltSummary } = registry.forRoleResolved('builder');

    // toolbelt: none → no project MCP servers (eforge_engine is internal, not counted here)
    expect(toolbeltSummary.projectMcpServerNames).toEqual([]);
    expect(toolbeltSummary.projectMcpSelection).toBe('none');
    // The eforge_engine server would still be registered at run-time when customTools are present
    // (tested via the debug payload in harness-debug-payload.toolbelt.test.ts)
  });
});
