import { useMemo } from 'react';
import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';
import type { OrchestrationConfig } from '@/lib/types';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 60;
const DEPTH_INDENT = 50;

export interface GraphLayoutResult {
  nodes: Node[];
  edges: Edge[];
  isLayoutReady: boolean;
}

export function computeGraphLayout(
  plans: OrchestrationConfig['plans'],
): { nodes: Node[]; edges: Edge[] } {
  if (plans.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Compute dependency depth for each node before layout
  // depth(root) = 0, depth(node) = max(depth(dep) for dep in dependsOn) + 1
  const depthMap = new Map<string, number>();
  const visiting = new Set<string>();
  function getDepth(planId: string): number {
    const cached = depthMap.get(planId);
    if (cached !== undefined) return cached;
    if (visiting.has(planId)) return 0; // cycle detected
    visiting.add(planId);
    const plan = plans.find((p) => p.id === planId);
    if (!plan || plan.dependsOn.length === 0) {
      depthMap.set(planId, 0);
      visiting.delete(planId);
      return 0;
    }
    const depth = Math.max(...plan.dependsOn.map(getDepth)) + 1;
    depthMap.set(planId, depth);
    visiting.delete(planId);
    return depth;
  }
  for (const plan of plans) {
    getDepth(plan.id);
  }

  const maxDepth = Math.max(0, ...depthMap.values());

  // Create dagre graph
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: Math.max(60, DEPTH_INDENT * maxDepth),
    ranksep: 120,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Add plan nodes
  for (const plan of plans) {
    g.setNode(plan.id, {
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  }

  // Add edges
  for (const plan of plans) {
    for (const dep of plan.dependsOn) {
      g.setEdge(dep, plan.id);
    }
  }

  // Run layout
  dagre.layout(g);

  // Build ReactFlow nodes
  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  // Create plan nodes
  for (const plan of plans) {
    const nodeData = g.node(plan.id);
    if (!nodeData) continue;
    const depth = depthMap.get(plan.id) ?? 0;

    rfNodes.push({
      id: plan.id,
      type: 'dagNode',
      position: {
        x: nodeData.x - NODE_WIDTH / 2 + DEPTH_INDENT * depth,
        y: nodeData.y - NODE_HEIGHT / 2,
      },
      data: {
        planId: plan.id,
        planName: plan.name,
        status: 'pending',
        highlighted: null, // null = normal, true = highlighted, false = dimmed
      },
    });
  }

  // Create edges
  for (const plan of plans) {
    for (const dep of plan.dependsOn) {
      rfEdges.push({
        id: `edge-${dep}-${plan.id}`,
        source: dep,
        target: plan.id,
        type: 'dagEdge',
        data: {
          sourceStatus: 'pending',
          targetStatus: 'pending',
        },
      });
    }
  }

  return { nodes: rfNodes, edges: rfEdges };
}

export function useGraphLayout(
  orchestration: OrchestrationConfig | null,
): GraphLayoutResult {
  return useMemo(() => {
    if (!orchestration) {
      return { nodes: [], edges: [], isLayoutReady: false };
    }

    const { nodes, edges } = computeGraphLayout(orchestration.plans);
    return { nodes, edges, isLayoutReady: true };
  }, [orchestration]);
}
