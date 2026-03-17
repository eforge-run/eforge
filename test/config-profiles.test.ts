import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveProfileExtensions,
  resolveConfig,
  mergePartialConfigs,
  BUILTIN_PROFILES,
  parseProfilesFile,
  validateProfileConfig,
} from '../src/engine/config.js';
import type {
  PartialProfileConfig,
  PartialEforgeConfig,
  ResolvedProfileConfig,
  AgentProfileConfig,
} from '../src/engine/config.js';
import type { AgentRole } from '../src/engine/events.js';

// --- resolveProfileExtensions ---

describe('resolveProfileExtensions', () => {
  it('returns all three built-in profiles when no user profiles given', () => {
    const result = resolveProfileExtensions({});
    expect(Object.keys(result).sort()).toEqual(['errand', 'excursion', 'expedition']);
    expect(result.errand).toEqual(BUILTIN_PROFILES.errand);
    expect(result.excursion).toEqual(BUILTIN_PROFILES.excursion);
    expect(result.expedition).toEqual(BUILTIN_PROFILES.expedition);
  });

  it('resolves a profile that extends a built-in', () => {
    const partials: Record<string, PartialProfileConfig> = {
      migration: {
        extends: 'errand',
        description: 'Database migration only',
      },
    };
    const result = resolveProfileExtensions(partials);
    expect(result.migration.description).toBe('Database migration only');
    expect(result.migration.compile).toEqual(BUILTIN_PROFILES.errand.compile);
    expect(result.migration.build).toEqual(BUILTIN_PROFILES.errand.build);
    expect(result.migration.review).toEqual(BUILTIN_PROFILES.errand.review);
  });

  it('resolves a chain: A extends B extends C', () => {
    const partials: Record<string, PartialProfileConfig> = {
      base: {
        extends: 'errand',
        description: 'Base custom',
        build: ['implement', 'validate'],
      },
      child: {
        extends: 'base',
        description: 'Child custom',
      },
    };
    const result = resolveProfileExtensions(partials);
    expect(result.child.description).toBe('Child custom');
    expect(result.child.build).toEqual(['implement', 'validate']); // inherited from base
    expect(result.child.compile).toEqual(BUILTIN_PROFILES.errand.compile); // inherited from errand via base
  });

  it('detects circular extension (A extends B, B extends A)', () => {
    const partials: Record<string, PartialProfileConfig> = {
      a: { extends: 'b', description: 'A' },
      b: { extends: 'a', description: 'B' },
    };
    expect(() => resolveProfileExtensions(partials)).toThrow(/Circular/);
  });

  it('detects self-referencing extension', () => {
    const partials: Record<string, PartialProfileConfig> = {
      self: { extends: 'self', description: 'Self' },
    };
    expect(() => resolveProfileExtensions(partials)).toThrow(/Circular/);
  });

  it('throws for profile extending a non-existent name', () => {
    const partials: Record<string, PartialProfileConfig> = {
      broken: { extends: 'nonexistent', description: 'Broken' },
    };
    expect(() => resolveProfileExtensions(partials)).toThrow(/not found/);
  });

  it('custom profile with no extends falls back to excursion built-in defaults', () => {
    const partials: Record<string, PartialProfileConfig> = {
      custom: { description: 'Custom profile' },
    };
    const result = resolveProfileExtensions(partials);
    expect(result.custom.description).toBe('Custom profile');
    expect(result.custom.compile).toEqual(BUILTIN_PROFILES.excursion.compile);
    expect(result.custom.build).toEqual(BUILTIN_PROFILES.excursion.build);
    expect(result.custom.review).toEqual(BUILTIN_PROFILES.excursion.review);
  });

  it('built-in override: user redefines errand with custom build', () => {
    const partials: Record<string, PartialProfileConfig> = {
      errand: { build: ['implement'] },
    };
    const result = resolveProfileExtensions(partials);
    expect(result.errand.build).toEqual(['implement']);
    expect(result.errand.compile).toEqual(BUILTIN_PROFILES.errand.compile); // inherited from built-in
  });

  it('agent config merges per-agent', () => {
    const builtins: Record<string, ResolvedProfileConfig> = {
      base: {
        description: 'Base',
        compile: ['planner'],
        build: ['implement'],
        agents: { builder: { maxTurns: 50 } },
        review: BUILTIN_PROFILES.excursion.review,
      },
    };
    const partials: Record<string, PartialProfileConfig> = {
      child: {
        extends: 'base',
        agents: { builder: { prompt: 'custom' } },
      },
    };
    const result = resolveProfileExtensions(partials, builtins);
    expect(result.child.agents.builder).toEqual({ maxTurns: 50, prompt: 'custom' });
  });

  it('review config shallow-merges', () => {
    const partials: Record<string, PartialProfileConfig> = {
      custom: {
        extends: 'excursion',
        review: { maxRounds: 2 },
      },
    };
    const result = resolveProfileExtensions(partials);
    expect(result.custom.review.maxRounds).toBe(2);
    expect(result.custom.review.strategy).toBe('auto'); // inherited from excursion
  });
});

// --- parseRawConfig with profiles ---

describe('parseRawConfig profile parsing (via resolveConfig round-trip)', () => {
  // We test parseRawConfig indirectly through resolveConfig since parseRawConfig is not exported.
  // The profiles field on PartialEforgeConfig flows through.

  it('empty profiles section results in empty record', () => {
    const config: PartialEforgeConfig = { profiles: {} };
    const resolved = resolveConfig(config, {});
    // Should have exactly the 3 built-ins
    expect(Object.keys(resolved.profiles).sort()).toEqual(['errand', 'excursion', 'expedition']);
  });
});

// --- mergePartialConfigs with profiles ---

describe('mergePartialConfigs with profiles', () => {
  it('disjoint profile names from global and project both appear', () => {
    const global: PartialEforgeConfig = {
      profiles: { alpha: { description: 'Alpha' } },
    };
    const project: PartialEforgeConfig = {
      profiles: { beta: { description: 'Beta' } },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.profiles?.alpha?.description).toBe('Alpha');
    expect(merged.profiles?.beta?.description).toBe('Beta');
  });

  it('same profile name: project fields override global scalars', () => {
    const global: PartialEforgeConfig = {
      profiles: {
        shared: {
          description: 'Global desc',
          extends: 'errand',
          compile: ['planner'],
          build: ['implement'],
        },
      },
    };
    const project: PartialEforgeConfig = {
      profiles: {
        shared: {
          description: 'Project desc',
          build: ['implement', 'review'],
        },
      },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.profiles?.shared?.description).toBe('Project desc');
    expect(merged.profiles?.shared?.build).toEqual(['implement', 'review']);
  });

  it('same profile name: agents merge per-agent', () => {
    const global: PartialEforgeConfig = {
      profiles: {
        shared: {
          agents: { reviewer: { maxTurns: 10 } },
        },
      },
    };
    const project: PartialEforgeConfig = {
      profiles: {
        shared: {
          agents: { builder: { maxTurns: 20 } },
        },
      },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.profiles?.shared?.agents?.reviewer).toEqual({ maxTurns: 10 });
    expect(merged.profiles?.shared?.agents?.builder).toEqual({ maxTurns: 20 });
  });

  it('same profile name: review fields merge shallowly', () => {
    const global: PartialEforgeConfig = {
      profiles: {
        shared: {
          review: { strategy: 'parallel' },
        },
      },
    };
    const project: PartialEforgeConfig = {
      profiles: {
        shared: {
          review: { maxRounds: 3 },
        },
      },
    };
    const merged = mergePartialConfigs(global, project);
    expect(merged.profiles?.shared?.review?.strategy).toBe('parallel');
    expect(merged.profiles?.shared?.review?.maxRounds).toBe(3);
  });

  it('only global has profiles - they survive', () => {
    const global: PartialEforgeConfig = {
      profiles: { solo: { description: 'Solo' } },
    };
    const merged = mergePartialConfigs(global, {});
    expect(merged.profiles?.solo?.description).toBe('Solo');
  });

  it('only project has profiles - they survive', () => {
    const project: PartialEforgeConfig = {
      profiles: { solo: { description: 'Solo' } },
    };
    const merged = mergePartialConfigs({}, project);
    expect(merged.profiles?.solo?.description).toBe('Solo');
  });
});

// --- resolveConfig integration with profiles ---

describe('resolveConfig with profiles', () => {
  it('empty config resolves with all three built-in profiles', () => {
    const config = resolveConfig({}, {});
    expect(Object.keys(config.profiles).sort()).toEqual(['errand', 'excursion', 'expedition']);
    expect(config.profiles.errand).toEqual(BUILTIN_PROFILES.errand);
  });

  it('config with custom profile resolves extensions and includes built-ins', () => {
    const config = resolveConfig(
      {
        profiles: {
          migration: { extends: 'errand', description: 'DB migration' },
        },
      },
      {},
    );
    expect(config.profiles.migration.description).toBe('DB migration');
    expect(config.profiles.errand).toBeDefined();
    expect(config.profiles.excursion).toBeDefined();
    expect(config.profiles.expedition).toBeDefined();
  });

  it('resolved profiles in returned config are frozen', () => {
    const config = resolveConfig({}, {});
    expect(Object.isFrozen(config.profiles)).toBe(true);
  });
});

// --- parseProfilesFile ---

describe('parseProfilesFile', () => {
  let tmpDir: string;

  async function writeTmpFile(name: string, content: string): Promise<string> {
    tmpDir = await mkdtemp(join(tmpdir(), 'eforge-test-'));
    const filePath = join(tmpDir, name);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  it('parses a valid YAML file with profiles section', async () => {
    const path = await writeTmpFile('profiles.yaml', `
profiles:
  quick:
    description: Quick change
    extends: errand
    build:
      - implement
`);
    const result = await parseProfilesFile(path);
    expect(result.quick?.description).toBe('Quick change');
    expect(result.quick?.extends).toBe('errand');
    expect(result.quick?.build).toEqual(['implement']);
    await rm(tmpDir, { recursive: true });
  });

  it('returns empty record for file with no profiles section', async () => {
    const path = await writeTmpFile('empty.yaml', `
agents:
  maxTurns: 50
`);
    const result = await parseProfilesFile(path);
    expect(result).toEqual({});
    await rm(tmpDir, { recursive: true });
  });

  it('returns empty record for invalid YAML content', async () => {
    const path = await writeTmpFile('bad.yaml', 'just a string');
    const result = await parseProfilesFile(path);
    expect(result).toEqual({});
    await rm(tmpDir, { recursive: true });
  });
});

// --- doc-updater agent role validation ---

describe('doc-updater agent role', () => {
  it('doc-updater is accepted as a valid agent role in profile config', () => {
    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES.excursion,
      agents: { 'doc-updater': { maxTurns: 15 } },
    };
    const { valid, errors } = validateProfileConfig(profile);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });
});

// --- nested array (parallel stage group) schema validation ---

describe('nested array schema validation for build field', () => {
  it('partial profile config accepts nested arrays in build', () => {
    const partials: Record<string, PartialProfileConfig> = {
      custom: {
        description: 'Custom profile with parallel groups',
        build: [['implement', 'doc-update'], 'review'],
      },
    };
    const result = resolveProfileExtensions(partials);
    expect(result.custom.build).toEqual([['implement', 'doc-update'], 'review']);
  });

  it('resolved profile config accepts nested arrays in build', () => {
    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES.excursion,
      build: [['implement', 'doc-update'], 'review', 'evaluate'],
    };
    const buildStages = new Set(['implement', 'doc-update', 'review', 'evaluate']);
    const { valid, errors } = validateProfileConfig(profile, undefined, buildStages);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('validateProfileConfig catches unknown stages inside nested arrays', () => {
    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES.excursion,
      build: [['implement', 'nonexistent'], 'review'],
    };
    const buildStages = new Set(['implement', 'review']);
    const { valid, errors } = validateProfileConfig(profile, undefined, buildStages);
    expect(valid).toBe(false);
    expect(errors).toContain('unknown build stage: "nonexistent"');
  });

  it('resolveConfig round-trip preserves nested arrays in build', () => {
    const config = resolveConfig(
      {
        profiles: {
          parallel: {
            description: 'Parallel test',
            build: [['implement', 'doc-update'], 'review'],
          },
        },
      },
      {},
    );
    expect(config.profiles.parallel.build).toEqual([['implement', 'doc-update'], 'review']);
  });
});

// --- loadPrompt path support ---

describe('loadPrompt path support', () => {
  // Tested indirectly via integration - the implementation is straightforward.
  // Path detection: name.includes('/') means path-based load.

  it('name without / loads from built-in prompts dir (smoke test)', async () => {
    const { loadPrompt } = await import('../src/engine/prompts.js');
    // 'planner' should load from the built-in prompts dir
    const content = await loadPrompt('planner');
    expect(content).toBeTruthy();
    expect(typeof content).toBe('string');
  });

  it('name containing / loads from that path directly', async () => {
    const { loadPrompt } = await import('../src/engine/prompts.js');
    const tmpDir = await mkdtemp(join(tmpdir(), 'eforge-prompt-'));
    const filePath = join(tmpDir, 'custom-prompt.md');
    await writeFile(filePath, 'Custom prompt content with {{var}}', 'utf-8');

    const content = await loadPrompt(filePath, { var: 'replaced' });
    expect(content).toBe('Custom prompt content with replaced');
    await rm(tmpDir, { recursive: true });
  });
});
