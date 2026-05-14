import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESERVED_TOOLBELT_NAMES,
  loadProjectMcpServerNames,
  validateToolbeltReferences,
  validateConfigFile,
  loadConfig,
  setActiveProfile,
  createAgentRuntimeProfile,
  ConfigValidationError,
  parseRawConfig,
  eforgeConfigSchema,
} from '@eforge-build/engine/config';
import type { PartialEforgeConfig } from '@eforge-build/engine/config';

// ---------------------------------------------------------------------------
// RESERVED_TOOLBELT_NAMES
// ---------------------------------------------------------------------------

describe('RESERVED_TOOLBELT_NAMES', () => {
  it('contains "none"', () => {
    expect(RESERVED_TOOLBELT_NAMES.has('none')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toolbeltConfigSchema via parseRawConfig / eforgeConfigSchema
// ---------------------------------------------------------------------------

describe('tools.toolbelts schema validation', () => {
  it('accepts a valid toolbelt definition', () => {
    const result = eforgeConfigSchema.safeParse({
      tools: {
        toolbelts: {
          'my-tools': {
            description: 'My toolbelt',
            mcpServers: ['server-a'],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts toolbelt without description', () => {
    const result = eforgeConfigSchema.safeParse({
      tools: {
        toolbelts: {
          'minimal': {
            mcpServers: ['server-a'],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts toolbelt name with dots, underscores, and dashes', () => {
    const result = eforgeConfigSchema.safeParse({
      tools: {
        toolbelts: {
          'my.tools_v2-beta': {
            mcpServers: ['server-a'],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects toolbelt with empty mcpServers array', () => {
    const result = eforgeConfigSchema.safeParse({
      tools: {
        toolbelts: {
          'my-tools': {
            mcpServers: [],
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects toolbelt with empty string in mcpServers', () => {
    const result = eforgeConfigSchema.safeParse({
      tools: {
        toolbelts: {
          'my-tools': {
            mcpServers: [''],
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects reserved toolbelt name "none"', () => {
    const result = eforgeConfigSchema.safeParse({
      tools: {
        toolbelts: {
          none: {
            mcpServers: ['server-a'],
          },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/reserved/);
    }
  });

  it('rejects toolbelt name with invalid characters', () => {
    const result = eforgeConfigSchema.safeParse({
      tools: {
        toolbelts: {
          'my tools!': {
            mcpServers: ['server-a'],
          },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('\n');
      expect(messages).toMatch(/pattern/);
    }
  });
});

// ---------------------------------------------------------------------------
// tierConfigSchema — toolbelt field
// ---------------------------------------------------------------------------

describe('tierConfigSchema toolbelt field', () => {
  it('accepts tier with toolbelt field', () => {
    const result = parseRawConfig({
      agents: {
        tiers: {
          implementation: {
            harness: 'claude-sdk',
            model: 'claude-sonnet-4-6',
            effort: 'medium',
            toolbelt: 'my-tools',
          },
        },
      },
    }, 'profile');
    expect((result.agents?.tiers?.['implementation'] as { toolbelt?: string })?.toolbelt).toBe('my-tools');
  });

  it('accepts tier with toolbelt "none"', () => {
    const result = parseRawConfig({
      agents: {
        tiers: {
          implementation: {
            harness: 'claude-sdk',
            model: 'claude-sonnet-4-6',
            effort: 'medium',
            toolbelt: 'none',
          },
        },
      },
    }, 'profile');
    expect((result.agents?.tiers?.['implementation'] as { toolbelt?: string })?.toolbelt).toBe('none');
  });

  it('accepts tier without toolbelt field', () => {
    const result = parseRawConfig({
      agents: {
        tiers: {
          planning: {
            harness: 'claude-sdk',
            model: 'claude-opus-4-7',
            effort: 'high',
          },
        },
      },
    }, 'profile');
    expect(result.agents?.tiers?.planning).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// loadProjectMcpServerNames
// ---------------------------------------------------------------------------

describe('loadProjectMcpServerNames', () => {
  it('returns exists=false when .mcp.json does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eforge-mcp-test-'));
    try {
      const result = await loadProjectMcpServerNames(dir);
      expect(result.exists).toBe(false);
      expect(result.names).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('returns server names from .mcp.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eforge-mcp-test-'));
    try {
      await writeFile(
        join(dir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'server-a': { command: 'node', args: ['a.js'] },
            'server-b': { command: 'node', args: ['b.js'] },
          },
        }),
        'utf-8',
      );
      const result = await loadProjectMcpServerNames(dir);
      expect(result.exists).toBe(true);
      expect(result.names).toContain('server-a');
      expect(result.names).toContain('server-b');
      expect(result.names).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('returns exists=true with empty names when mcpServers key is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eforge-mcp-test-'));
    try {
      await writeFile(join(dir, '.mcp.json'), JSON.stringify({ other: {} }), 'utf-8');
      const result = await loadProjectMcpServerNames(dir);
      expect(result.exists).toBe(true);
      expect(result.names).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('throws ConfigValidationError on malformed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eforge-mcp-test-'));
    try {
      await writeFile(join(dir, '.mcp.json'), '{ invalid json }', 'utf-8');
      await expect(loadProjectMcpServerNames(dir)).rejects.toThrow(ConfigValidationError);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// validateToolbeltReferences
// ---------------------------------------------------------------------------

describe('validateToolbeltReferences', () => {
  it('returns no errors when no toolbelts are defined', () => {
    const errors = validateToolbeltReferences({}, null);
    expect(errors).toEqual([]);
  });

  it('returns no errors when tier toolbelt references a declared toolbelt', () => {
    const merged: PartialEforgeConfig = {
      tools: { toolbelts: { 'my-tools': { mcpServers: ['server-a'] } } },
      agents: {
        tiers: {
          implementation: {
            harness: 'claude-sdk',
            model: 'claude-sonnet-4-6',
            effort: 'medium',
            toolbelt: 'my-tools',
          } as any,
        },
      },
    };
    const errors = validateToolbeltReferences(merged, { exists: true, names: ['server-a'] });
    expect(errors).toEqual([]);
  });

  it('returns error when tier references an undeclared toolbelt', () => {
    const merged: PartialEforgeConfig = {
      tools: { toolbelts: {} },
      agents: {
        tiers: {
          implementation: {
            harness: 'claude-sdk',
            model: 'claude-sonnet-4-6',
            effort: 'medium',
            toolbelt: 'missing-toolbelt',
          } as any,
        },
      },
    };
    const errors = validateToolbeltReferences(merged, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/implementation.*toolbelt.*"missing-toolbelt"/);
    expect(errors[0]).toMatch(/no tools\.toolbelts\.missing-toolbelt is defined/);
  });

  it('does not error when tier toolbelt is "none"', () => {
    const merged: PartialEforgeConfig = {
      tools: { toolbelts: {} },
      agents: {
        tiers: {
          implementation: {
            harness: 'claude-sdk',
            model: 'claude-sonnet-4-6',
            effort: 'medium',
            toolbelt: 'none',
          } as any,
        },
      },
    };
    const errors = validateToolbeltReferences(merged, null);
    expect(errors).toEqual([]);
  });

  it('returns error when .mcp.json does not exist but toolbelt declares servers', () => {
    const merged: PartialEforgeConfig = {
      tools: { toolbelts: { 'my-tools': { mcpServers: ['server-a'] } } },
    };
    const errors = validateToolbeltReferences(merged, { exists: false, names: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/my-tools.*\.mcp\.json.*not found/);
  });

  it('returns error when toolbelt references MCP server not in .mcp.json', () => {
    const merged: PartialEforgeConfig = {
      tools: { toolbelts: { 'my-tools': { mcpServers: ['missing-server'] } } },
    };
    const errors = validateToolbeltReferences(merged, { exists: true, names: ['server-a'] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/my-tools.*"missing-server".*\.mcp\.json/);
  });

  it('skips MCP checks when mcpProbe is null', () => {
    const merged: PartialEforgeConfig = {
      tools: { toolbelts: { 'my-tools': { mcpServers: ['server-a'] } } },
    };
    const errors = validateToolbeltReferences(merged, null);
    expect(errors).toEqual([]);
  });

  it('returns multiple errors for multiple missing references', () => {
    const merged: PartialEforgeConfig = {
      tools: { toolbelts: { 'my-tools': { mcpServers: ['server-a', 'server-b'] } } },
      agents: {
        tiers: {
          planning: {
            harness: 'claude-sdk',
            model: 'claude-opus-4-7',
            effort: 'high',
            toolbelt: 'nonexistent',
          } as any,
          implementation: {
            harness: 'claude-sdk',
            model: 'claude-sonnet-4-6',
            effort: 'medium',
            toolbelt: 'also-missing',
          } as any,
        },
      },
    };
    const errors = validateToolbeltReferences(merged, { exists: true, names: [] });
    // 2 tier reference errors + 2 MCP server errors
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// validateConfigFile — toolbelt integration
// ---------------------------------------------------------------------------

describe('validateConfigFile toolbelt integration', () => {
  it('reports errors for toolbelt with missing MCP server', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'eforge-validate-test-'));
    try {
      await mkdir(join(projectDir, 'eforge'), { recursive: true });
      await writeFile(
        join(projectDir, 'eforge', 'config.yaml'),
        [
          'tools:',
          '  toolbelts:',
          '    my-tools:',
          '      mcpServers:',
          '        - missing-server',
          '',
        ].join('\n'),
        'utf-8',
      );
      await writeFile(
        join(projectDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'other-server': {} } }),
        'utf-8',
      );
      const result = await validateConfigFile(projectDir);
      expect(result.configFound).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('missing-server'))).toBe(true);
    } finally {
      await rm(projectDir, { recursive: true });
    }
  });

  it('passes when toolbelt references valid MCP servers', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'eforge-validate-test-'));
    try {
      await mkdir(join(projectDir, 'eforge'), { recursive: true });
      await writeFile(
        join(projectDir, 'eforge', 'config.yaml'),
        [
          'tools:',
          '  toolbelts:',
          '    my-tools:',
          '      mcpServers:',
          '        - server-a',
          '',
        ].join('\n'),
        'utf-8',
      );
      await writeFile(
        join(projectDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'server-a': {} } }),
        'utf-8',
      );
      const result = await validateConfigFile(projectDir);
      expect(result.configFound).toBe(true);
      expect(result.valid).toBe(true);
    } finally {
      await rm(projectDir, { recursive: true });
    }
  });

  it('reports error for tier referencing undefined toolbelt', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'eforge-validate-test-'));
    try {
      await mkdir(join(projectDir, 'eforge'), { recursive: true });
      await writeFile(
        join(projectDir, 'eforge', 'config.yaml'),
        [
          'agents:',
          '  tiers:',
          '    implementation:',
          '      harness: claude-sdk',
          '      model: claude-sonnet-4-6',
          '      effort: medium',
          '      toolbelt: nonexistent-toolbelt',
          '',
        ].join('\n'),
        'utf-8',
      );
      const result = await validateConfigFile(projectDir);
      expect(result.configFound).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('nonexistent-toolbelt'))).toBe(true);
    } finally {
      await rm(projectDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig — toolbelt warnings
// ---------------------------------------------------------------------------

describe('loadConfig toolbelt warnings', () => {
  it('emits a warning when toolbelt references an MCP server not in .mcp.json', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'eforge-loadconfig-test-'));
    try {
      await mkdir(join(projectDir, 'eforge'), { recursive: true });
      await writeFile(
        join(projectDir, 'eforge', 'config.yaml'),
        [
          'tools:',
          '  toolbelts:',
          '    my-tools:',
          '      mcpServers:',
          '        - missing-server',
          '',
        ].join('\n'),
        'utf-8',
      );
      await writeFile(
        join(projectDir, '.mcp.json'),
        JSON.stringify({ mcpServers: {} }),
        'utf-8',
      );
      const result = await loadConfig(projectDir);
      expect(result.warnings.some((w) => w.includes('missing-server'))).toBe(true);
    } finally {
      await rm(projectDir, { recursive: true });
    }
  });

  it('no warnings when toolbelts and MCP servers are consistent', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'eforge-loadconfig-test-'));
    try {
      await mkdir(join(projectDir, 'eforge'), { recursive: true });
      await writeFile(
        join(projectDir, 'eforge', 'config.yaml'),
        [
          'tools:',
          '  toolbelts:',
          '    my-tools:',
          '      mcpServers:',
          '        - server-a',
          '',
        ].join('\n'),
        'utf-8',
      );
      await writeFile(
        join(projectDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'server-a': {} } }),
        'utf-8',
      );
      const result = await loadConfig(projectDir);
      const toolbeltWarnings = result.warnings.filter((w) => w.includes('toolbelt'));
      expect(toolbeltWarnings).toEqual([]);
    } finally {
      await rm(projectDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// setActiveProfile — toolbelt validation
// ---------------------------------------------------------------------------

describe('setActiveProfile toolbelt validation', () => {
  it('rejects activating a profile that references an undeclared toolbelt', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'eforge-setprofile-test-'));
    const xdg = await mkdtemp(join(tmpdir(), 'eforge-xdg-'));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const configDir = join(projectDir, 'eforge');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.yaml'), '', 'utf-8');
      await mkdir(join(configDir, 'profiles'), { recursive: true });
      await writeFile(
        join(configDir, 'profiles', 'bad-profile.yaml'),
        [
          'agents:',
          '  tiers:',
          '    implementation:',
          '      harness: claude-sdk',
          '      model: claude-sonnet-4-6',
          '      effort: medium',
          '      toolbelt: nonexistent-toolbelt',
          '',
        ].join('\n'),
        'utf-8',
      );
      await expect(setActiveProfile(configDir, 'bad-profile', {}, projectDir)).rejects.toThrow(/toolbelt.*nonexistent-toolbelt/);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      await rm(projectDir, { recursive: true });
      await rm(xdg, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createAgentRuntimeProfile — toolbelt validation
// ---------------------------------------------------------------------------

describe('createAgentRuntimeProfile toolbelt validation', () => {
  it('rejects creating a profile that references an undeclared toolbelt', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'eforge-createprofile-test-'));
    const xdg = await mkdtemp(join(tmpdir(), 'eforge-xdg-'));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const configDir = join(projectDir, 'eforge');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.yaml'), '', 'utf-8');
      await expect(
        createAgentRuntimeProfile(configDir, {
          name: 'bad-profile',
          agents: {
            tiers: {
              implementation: {
                harness: 'claude-sdk',
                model: 'claude-sonnet-4-6',
                effort: 'medium',
                toolbelt: 'nonexistent-toolbelt',
              } as any,
            },
          },
        }, projectDir),
      ).rejects.toThrow(/toolbelt.*nonexistent-toolbelt/);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      await rm(projectDir, { recursive: true });
      await rm(xdg, { recursive: true });
    }
  });

  it('succeeds when toolbelt references match declared toolbelts', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'eforge-createprofile-test-'));
    const xdg = await mkdtemp(join(tmpdir(), 'eforge-xdg-'));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const configDir = join(projectDir, 'eforge');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, 'config.yaml'),
        [
          'tools:',
          '  toolbelts:',
          '    my-tools:',
          '      mcpServers:',
          '        - server-a',
          '',
        ].join('\n'),
        'utf-8',
      );
      await writeFile(
        join(projectDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'server-a': {} } }),
        'utf-8',
      );
      const result = await createAgentRuntimeProfile(configDir, {
        name: 'good-profile',
        agents: {
          tiers: {
            implementation: {
              harness: 'claude-sdk',
              model: 'claude-sonnet-4-6',
              effort: 'medium',
              toolbelt: 'my-tools',
            } as any,
          },
        },
      }, projectDir);
      expect(result.path).toMatch(/good-profile\.yaml$/);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      await rm(projectDir, { recursive: true });
      await rm(xdg, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// mergePartialConfigs — tools.toolbelts deep merge
// ---------------------------------------------------------------------------

describe('mergePartialConfigs tools.toolbelts', () => {
  it('merges toolbelts from global and project configs', async () => {
    // Import mergePartialConfigs directly
    const { mergePartialConfigs } = await import('@eforge-build/engine/config');
    const global: PartialEforgeConfig = {
      tools: { toolbelts: { 'global-tools': { mcpServers: ['server-g'] } } },
    };
    const project: PartialEforgeConfig = {
      tools: { toolbelts: { 'project-tools': { mcpServers: ['server-p'] } } },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.tools?.toolbelts?.['global-tools']).toBeDefined();
    expect(merged.tools?.toolbelts?.['project-tools']).toBeDefined();
  });

  it('project toolbelt wins over global when same name', async () => {
    const { mergePartialConfigs } = await import('@eforge-build/engine/config');
    const global: PartialEforgeConfig = {
      tools: { toolbelts: { 'shared': { mcpServers: ['global-server'] } } },
    };
    const project: PartialEforgeConfig = {
      tools: { toolbelts: { 'shared': { mcpServers: ['project-server'] } } },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.tools?.toolbelts?.['shared']?.mcpServers).toEqual(['project-server']);
  });
});
