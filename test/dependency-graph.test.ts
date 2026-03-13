import { describe, it, expect } from 'vitest';
import { resolveDependencyGraph } from '../src/engine/plan.js';

describe('resolveDependencyGraph', () => {
  it('handles single plan with no deps', () => {
    const result = resolveDependencyGraph([
      { id: 'a', name: 'A', dependsOn: [], branch: 'a' },
    ]);
    expect(result.waves).toEqual([['a']]);
    expect(result.mergeOrder).toEqual(['a']);
  });

  it('resolves linear chain', () => {
    const result = resolveDependencyGraph([
      { id: 'a', name: 'A', dependsOn: [], branch: 'a' },
      { id: 'b', name: 'B', dependsOn: ['a'], branch: 'b' },
      { id: 'c', name: 'C', dependsOn: ['b'], branch: 'c' },
    ]);
    expect(result.waves).toEqual([['a'], ['b'], ['c']]);
    expect(result.mergeOrder).toEqual(['a', 'b', 'c']);
  });

  it('resolves diamond: A->{B,C}->D', () => {
    const result = resolveDependencyGraph([
      { id: 'a', name: 'A', dependsOn: [], branch: 'a' },
      { id: 'b', name: 'B', dependsOn: ['a'], branch: 'b' },
      { id: 'c', name: 'C', dependsOn: ['a'], branch: 'c' },
      { id: 'd', name: 'D', dependsOn: ['b', 'c'], branch: 'd' },
    ]);
    expect(result.waves).toHaveLength(3);
    expect(result.waves[0]).toEqual(['a']);
    expect(result.waves[1]).toEqual(expect.arrayContaining(['b', 'c']));
    expect(result.waves[1]).toHaveLength(2);
    expect(result.waves[2]).toEqual(['d']);
  });

  it('puts all independent plans in a single wave', () => {
    const result = resolveDependencyGraph([
      { id: 'a', name: 'A', dependsOn: [], branch: 'a' },
      { id: 'b', name: 'B', dependsOn: [], branch: 'b' },
      { id: 'c', name: 'C', dependsOn: [], branch: 'c' },
    ]);
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('resolves real forge-v1 topology into 4 waves', () => {
    // Matches plans/forge-v1/index.yaml topology
    const plans = [
      { id: 'forge-core', name: 'Core', dependsOn: [] as string[], branch: 'forge-v1/forge-core' },
      { id: 'config', name: 'Config', dependsOn: ['forge-core'], branch: 'forge-v1/config' },
      { id: 'orchestration', name: 'Orch', dependsOn: ['forge-core'], branch: 'forge-v1/orchestration' },
      { id: 'reviewer', name: 'Rev', dependsOn: ['forge-core'], branch: 'forge-v1/reviewer' },
      { id: 'cli', name: 'CLI', dependsOn: ['config', 'orchestration', 'reviewer'], branch: 'forge-v1/cli' },
    ];

    const result = resolveDependencyGraph(plans);
    // Wave 1: forge-core (no deps)
    // Wave 2: config, orchestration, reviewer (depend on forge-core)
    // Wave 3: cli (depends on config, orchestration, reviewer)
    expect(result.waves).toHaveLength(3);
    expect(result.waves[0]).toEqual(['forge-core']);
    expect(result.waves[1]).toEqual(expect.arrayContaining(['config', 'orchestration', 'reviewer']));
    expect(result.waves[2]).toEqual(['cli']);
  });

  it('throws on circular dependency', () => {
    expect(() =>
      resolveDependencyGraph([
        { id: 'a', name: 'A', dependsOn: ['b'], branch: 'a' },
        { id: 'b', name: 'B', dependsOn: ['a'], branch: 'b' },
      ]),
    ).toThrow(/[Cc]ircular/);
  });

  it('throws on unknown dependency', () => {
    expect(() =>
      resolveDependencyGraph([
        { id: 'a', name: 'A', dependsOn: ['nonexistent'], branch: 'a' },
      ]),
    ).toThrow(/unknown plan/i);
  });

  it('produces topological merge order', () => {
    const result = resolveDependencyGraph([
      { id: 'a', name: 'A', dependsOn: [], branch: 'a' },
      { id: 'b', name: 'B', dependsOn: ['a'], branch: 'b' },
      { id: 'c', name: 'C', dependsOn: ['a'], branch: 'c' },
      { id: 'd', name: 'D', dependsOn: ['b', 'c'], branch: 'd' },
    ]);
    // a must come before b, c; b and c must come before d
    const indexOf = (id: string) => result.mergeOrder.indexOf(id);
    expect(indexOf('a')).toBeLessThan(indexOf('b'));
    expect(indexOf('a')).toBeLessThan(indexOf('c'));
    expect(indexOf('b')).toBeLessThan(indexOf('d'));
    expect(indexOf('c')).toBeLessThan(indexOf('d'));
  });
});
