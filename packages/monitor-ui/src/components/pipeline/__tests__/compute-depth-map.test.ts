import { describe, it, expect } from 'vitest';
import { computeDepthMap } from '../compute-depth-map';
import type { OrchestrationConfig } from '@/lib/types';

type PlanEntry = OrchestrationConfig['plans'][number];

function makePlan(id: string, dependsOn: string[] = []): PlanEntry {
  return {
    id,
    name: id,
    dependsOn,
    branch: `branch-${id}`,
    build: [],
    review: {} as PlanEntry['review'],
  };
}

describe('computeDepthMap', () => {
  it('assigns depth 0 to all nodes in a single root (no dependencies)', () => {
    const plans = [makePlan('a'), makePlan('b'), makePlan('c')];
    const depthMap = computeDepthMap(plans);
    expect(depthMap.get('a')).toBe(0);
    expect(depthMap.get('b')).toBe(0);
    expect(depthMap.get('c')).toBe(0);
  });

  it('computes depth for a linear chain: a → b → c', () => {
    const plans = [
      makePlan('a'),
      makePlan('b', ['a']),
      makePlan('c', ['b']),
    ];
    const depthMap = computeDepthMap(plans);
    expect(depthMap.get('a')).toBe(0);
    expect(depthMap.get('b')).toBe(1);
    expect(depthMap.get('c')).toBe(2);
  });

  it('uses the longest path in a branching DAG', () => {
    // a → c, b → c; a → b
    // depth(a) = 0, depth(b) = 1, depth(c) = max(0+1, 1+1) = 2
    const plans = [
      makePlan('a'),
      makePlan('b', ['a']),
      makePlan('c', ['a', 'b']),
    ];
    const depthMap = computeDepthMap(plans);
    expect(depthMap.get('a')).toBe(0);
    expect(depthMap.get('b')).toBe(1);
    expect(depthMap.get('c')).toBe(2);
  });

  it('handles a diamond DAG: a → b, a → c, b → d, c → d', () => {
    const plans = [
      makePlan('a'),
      makePlan('b', ['a']),
      makePlan('c', ['a']),
      makePlan('d', ['b', 'c']),
    ];
    const depthMap = computeDepthMap(plans);
    expect(depthMap.get('a')).toBe(0);
    expect(depthMap.get('b')).toBe(1);
    expect(depthMap.get('c')).toBe(1);
    expect(depthMap.get('d')).toBe(2);
  });

  it('does not infinite-loop on cyclic input (cycle guard returns 0)', () => {
    // a → b → a (cycle)
    const plans = [
      makePlan('a', ['b']),
      makePlan('b', ['a']),
    ];
    // Should not throw and should terminate
    expect(() => computeDepthMap(plans)).not.toThrow();
    const depthMap = computeDepthMap(plans);
    // The cycle guard returns 0 for any node encountered mid-recursion,
    // so both nodes get a finite depth.
    expect(depthMap.has('a')).toBe(true);
    expect(depthMap.has('b')).toBe(true);
  });

  it('returns an empty map for an empty plans array', () => {
    const depthMap = computeDepthMap([]);
    expect(depthMap.size).toBe(0);
  });
});
