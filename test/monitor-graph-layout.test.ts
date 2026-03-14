import { describe, it, expect } from 'vitest';
import { computeGraphLayout } from '../src/monitor/ui/src/components/graph/use-graph-layout';
import type { OrchestrationConfig } from '../src/engine/events';

type PlanEntry = OrchestrationConfig['plans'][number];

function makePlan(id: string, name: string, dependsOn: string[] = []): PlanEntry {
  return { id, name, dependsOn, branch: `branch-${id}` };
}

describe('computeGraphLayout', () => {
  it('returns empty layout for no plans', () => {
    const { nodes, edges } = computeGraphLayout([]);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('single plan (errand): 1 plan node, 0 edges, 1 wave group', () => {
    const plans = [makePlan('p1', 'Plan One')];
    const { nodes, edges } = computeGraphLayout(plans);

    const waveNodes = nodes.filter((n) => n.type === 'group');
    const planNodes = nodes.filter((n) => n.type === 'dagNode');

    expect(waveNodes).toHaveLength(1);
    expect(waveNodes[0].id).toBe('wave-0');
    expect(planNodes).toHaveLength(1);
    expect(planNodes[0].id).toBe('p1');
    expect(planNodes[0].parentId).toBe('wave-0');
    expect(edges).toHaveLength(0);
  });

  it('three independent plans (excursion): 3 nodes, 0 edges, 1 wave group', () => {
    const plans = [
      makePlan('p1', 'Plan One'),
      makePlan('p2', 'Plan Two'),
      makePlan('p3', 'Plan Three'),
    ];
    const { nodes, edges } = computeGraphLayout(plans);

    const waveNodes = nodes.filter((n) => n.type === 'group');
    const planNodes = nodes.filter((n) => n.type === 'dagNode');

    expect(waveNodes).toHaveLength(1);
    expect(planNodes).toHaveLength(3);
    expect(edges).toHaveLength(0);

    // All nodes should be in wave 0
    for (const node of planNodes) {
      expect(node.parentId).toBe('wave-0');
    }
  });

  it('linear dependency chain (A → B → C): 3 nodes, 2 edges, 3 wave groups', () => {
    const plans = [
      makePlan('a', 'Plan A'),
      makePlan('b', 'Plan B', ['a']),
      makePlan('c', 'Plan C', ['b']),
    ];
    const { nodes, edges } = computeGraphLayout(plans);

    const waveNodes = nodes.filter((n) => n.type === 'group');
    const planNodes = nodes.filter((n) => n.type === 'dagNode');

    expect(waveNodes).toHaveLength(3);
    expect(planNodes).toHaveLength(3);
    expect(edges).toHaveLength(2);

    // Verify wave assignments
    const planA = planNodes.find((n) => n.id === 'a')!;
    const planB = planNodes.find((n) => n.id === 'b')!;
    const planC = planNodes.find((n) => n.id === 'c')!;
    expect(planA.parentId).toBe('wave-0');
    expect(planB.parentId).toBe('wave-1');
    expect(planC.parentId).toBe('wave-2');

    // Verify edges
    expect(edges.find((e) => e.source === 'a' && e.target === 'b')).toBeDefined();
    expect(edges.find((e) => e.source === 'b' && e.target === 'c')).toBeDefined();
  });

  it('diamond pattern (A → B, A → C, B → D, C → D): 4 nodes, 4 edges, 3 wave groups', () => {
    const plans = [
      makePlan('a', 'Plan A'),
      makePlan('b', 'Plan B', ['a']),
      makePlan('c', 'Plan C', ['a']),
      makePlan('d', 'Plan D', ['b', 'c']),
    ];
    const { nodes, edges } = computeGraphLayout(plans);

    const waveNodes = nodes.filter((n) => n.type === 'group');
    const planNodes = nodes.filter((n) => n.type === 'dagNode');

    expect(waveNodes).toHaveLength(3);
    expect(planNodes).toHaveLength(4);
    expect(edges).toHaveLength(4);

    // Verify wave assignments
    expect(planNodes.find((n) => n.id === 'a')!.parentId).toBe('wave-0');
    expect(planNodes.find((n) => n.id === 'b')!.parentId).toBe('wave-1');
    expect(planNodes.find((n) => n.id === 'c')!.parentId).toBe('wave-1');
    expect(planNodes.find((n) => n.id === 'd')!.parentId).toBe('wave-2');
  });

  it('nodes have non-zero positions', () => {
    const plans = [
      makePlan('a', 'Plan A'),
      makePlan('b', 'Plan B', ['a']),
    ];
    const { nodes } = computeGraphLayout(plans);
    const planNodes = nodes.filter((n) => n.type === 'dagNode');

    for (const node of planNodes) {
      // Positions are relative to parent, so they should be non-negative
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('edges reference valid source/target node IDs', () => {
    const plans = [
      makePlan('a', 'Plan A'),
      makePlan('b', 'Plan B', ['a']),
      makePlan('c', 'Plan C', ['a', 'b']),
    ];
    const { nodes, edges } = computeGraphLayout(plans);
    const planNodeIds = new Set(nodes.filter((n) => n.type === 'dagNode').map((n) => n.id));

    for (const edge of edges) {
      expect(planNodeIds.has(edge.source)).toBe(true);
      expect(planNodeIds.has(edge.target)).toBe(true);
    }
  });

  it('plan node data includes correct wave number and plan name', () => {
    const plans = [
      makePlan('p1', 'My Plan'),
      makePlan('p2', 'Dep Plan', ['p1']),
    ];
    const { nodes } = computeGraphLayout(plans);

    const p1 = nodes.find((n) => n.id === 'p1')!;
    const p2 = nodes.find((n) => n.id === 'p2')!;

    expect(p1.data.planName).toBe('My Plan');
    expect(p1.data.wave).toBe(1); // wave 0 displayed as 1
    expect(p2.data.planName).toBe('Dep Plan');
    expect(p2.data.wave).toBe(2); // wave 1 displayed as 2
  });
});
