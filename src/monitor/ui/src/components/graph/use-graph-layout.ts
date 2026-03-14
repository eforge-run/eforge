import { useMemo } from 'react';
import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';
import type { OrchestrationConfig } from '@/lib/types';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 60;
const WAVE_PADDING = 40;
const WAVE_LABEL_HEIGHT = 28;

export interface GraphLayoutResult {
  nodes: Node[];
  edges: Edge[];
  isLayoutReady: boolean;
}

/** Compute wave assignments from the orchestration plan list */
function computeWaves(plans: OrchestrationConfig['plans']): Map<string, number> {
  const waveMap = new Map<string, number>();
  const planMap = new Map(plans.map((p) => [p.id, p]));
  const visiting = new Set<string>();

  function getWave(planId: string): number {
    if (waveMap.has(planId)) return waveMap.get(planId)!;
    if (visiting.has(planId)) return 0; // Break cycle — treat as root
    const plan = planMap.get(planId);
    if (!plan || plan.dependsOn.length === 0) {
      waveMap.set(planId, 0);
      return 0;
    }
    visiting.add(planId);
    const depWave = Math.max(...plan.dependsOn.map((d) => getWave(d)));
    visiting.delete(planId);
    const wave = depWave + 1;
    waveMap.set(planId, wave);
    return wave;
  }

  for (const plan of plans) {
    getWave(plan.id);
  }

  return waveMap;
}

export function computeGraphLayout(
  plans: OrchestrationConfig['plans'],
): { nodes: Node[]; edges: Edge[] } {
  if (plans.length === 0) {
    return { nodes: [], edges: [] };
  }

  const waveMap = computeWaves(plans);
  const maxWave = Math.max(...waveMap.values());

  // Create dagre graph
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setGraph({
    rankdir: 'TB',
    nodesep: 60,
    ranksep: 100,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Add plan nodes
  for (const plan of plans) {
    g.setNode(plan.id, {
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      wave: waveMap.get(plan.id) ?? 0,
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

  // Compute wave group bounds
  const waveBounds = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }>();
  for (const plan of plans) {
    const nodeData = g.node(plan.id);
    if (!nodeData) continue;
    const wave = waveMap.get(plan.id) ?? 0;
    const bounds = waveBounds.get(wave) ?? {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
    };
    bounds.minX = Math.min(bounds.minX, nodeData.x - NODE_WIDTH / 2);
    bounds.maxX = Math.max(bounds.maxX, nodeData.x + NODE_WIDTH / 2);
    bounds.minY = Math.min(bounds.minY, nodeData.y - NODE_HEIGHT / 2);
    bounds.maxY = Math.max(bounds.maxY, nodeData.y + NODE_HEIGHT / 2);
    waveBounds.set(wave, bounds);
  }

  // Create wave group nodes (background)
  for (let w = 0; w <= maxWave; w++) {
    const bounds = waveBounds.get(w);
    if (!bounds) continue;

    rfNodes.push({
      id: `wave-${w}`,
      type: 'group',
      position: {
        x: bounds.minX - WAVE_PADDING,
        y: bounds.minY - WAVE_PADDING - WAVE_LABEL_HEIGHT,
      },
      data: { label: `Wave ${w + 1}` },
      style: {
        width: bounds.maxX - bounds.minX + WAVE_PADDING * 2,
        height: bounds.maxY - bounds.minY + WAVE_PADDING * 2 + WAVE_LABEL_HEIGHT,
        backgroundColor: 'rgba(48, 54, 61, 0.3)',
        borderRadius: '8px',
        border: '1px solid var(--color-border)',
        padding: '0',
        fontSize: '11px',
        color: 'var(--color-text-dim)',
      },
    });
  }

  // Create plan nodes positioned relative to their wave group parent
  for (const plan of plans) {
    const nodeData = g.node(plan.id);
    if (!nodeData) continue;

    const wave = waveMap.get(plan.id) ?? 0;
    const waveBound = waveBounds.get(wave)!;
    const groupX = waveBound.minX - WAVE_PADDING;
    const groupY = waveBound.minY - WAVE_PADDING - WAVE_LABEL_HEIGHT;

    rfNodes.push({
      id: plan.id,
      type: 'dagNode',
      position: {
        x: nodeData.x - NODE_WIDTH / 2 - groupX,
        y: nodeData.y - NODE_HEIGHT / 2 - groupY,
      },
      parentId: `wave-${wave}`,
      extent: 'parent' as const,
      data: {
        planId: plan.id,
        planName: plan.name,
        wave: wave + 1,
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
