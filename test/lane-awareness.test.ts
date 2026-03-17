import { describe, it, expect } from 'vitest';
import { formatParallelLanes } from '../src/engine/agents/planner.js';
import { formatBuilderParallelNotice } from '../src/engine/agents/builder.js';
import { BUILTIN_PROFILES } from '../src/engine/config.js';
import type { ResolvedProfileConfig } from '../src/engine/config.js';

describe('formatParallelLanes', () => {
  it('returns empty string when profile has no parallel groups', () => {
    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      build: ['implement', 'review', 'review-fix', 'evaluate'],
    };

    expect(formatParallelLanes(profile)).toBe('');
  });

  it('returns formatted section when parallel groups exist', () => {
    const profile: ResolvedProfileConfig = {
      ...BUILTIN_PROFILES['excursion'],
      build: [['implement', 'doc-update'], 'review', 'review-fix', 'evaluate'],
    };

    const result = formatParallelLanes(profile);
    expect(result).toContain('Parallel Build Lanes');
    expect(result).toContain('`implement`');
    expect(result).toContain('`doc-update`');
    expect(result).toContain('doc-updater');
  });

  it('returns formatted section for default built-in profiles', () => {
    // After our changes, all built-in profiles use DEFAULT_BUILD_STAGES which has parallel groups
    const result = formatParallelLanes(BUILTIN_PROFILES['excursion']);
    expect(result).toContain('Parallel Build Lanes');
  });
});

describe('formatBuilderParallelNotice', () => {
  it('returns empty string when builder is not in a parallel group', () => {
    // No parallel groups at all
    expect(formatBuilderParallelNotice([])).toBe('');
  });

  it('returns empty string when parallel group does not contain implement', () => {
    // Parallel group exists but doesn't include 'implement'
    expect(formatBuilderParallelNotice([['review', 'doc-update']])).toBe('');
  });

  it('returns notice with parallel stage names when builder is in a parallel group', () => {
    const result = formatBuilderParallelNotice([['implement', 'doc-update']]);
    expect(result).toContain('Parallel Execution Notice');
    expect(result).toContain('`doc-update`');
    expect(result).toContain('Stay in your lane');
    expect(result).toContain('targeted');
  });

  it('lists multiple parallel stages when present', () => {
    const result = formatBuilderParallelNotice([['implement', 'doc-update', 'lint']]);
    expect(result).toContain('`doc-update`');
    expect(result).toContain('`lint`');
    // Should not list implement itself as "other"
    expect(result).not.toContain('`implement`');
  });
});
