import { useState, useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type NodeTypes,
  type EdgeTypes,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { OrchestrationConfig, PipelineStage } from '@/lib/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useGraphLayout } from './use-graph-layout';
import { DagNode } from './dag-node';
import { DagEdge } from './dag-edge';
import { resolveNodeStatus, type GraphNodeStatus } from './graph-status';

const EMPTY_SET = new Set<string>();

const nodeTypes: NodeTypes = {
  dagNode: DagNode,
};

const edgeTypes: EdgeTypes = {
  dagEdge: DagEdge,
};

interface DependencyGraphProps {
  orchestration: OrchestrationConfig | null;
  planStatuses: Record<string, PipelineStage>;
  mergedPlanIds?: Set<string>;
}

export function DependencyGraph({
  orchestration,
  planStatuses,
  mergedPlanIds = EMPTY_SET,
}: DependencyGraphProps) {
  const { nodes: layoutNodes, edges: layoutEdges, isLayoutReady } = useGraphLayout(orchestration);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Build adjacency maps for highlight logic
  const { upstream, downstream } = useMemo(() => {
    const up = new Map<string, Set<string>>();
    const down = new Map<string, Set<string>>();

    for (const edge of layoutEdges) {
      // source → target (source is upstream of target)
      if (!down.has(edge.source)) down.set(edge.source, new Set());
      down.get(edge.source)!.add(edge.target);
      if (!up.has(edge.target)) up.set(edge.target, new Set());
      up.get(edge.target)!.add(edge.source);
    }

    return { upstream: up, downstream: down };
  }, [layoutEdges]);

  // Collect all connected nodes for highlight
  const highlightedNodes = useMemo(() => {
    if (!selectedNodeId) return null;

    const connected = new Set<string>([selectedNodeId]);

    // Walk upstream (dependencies)
    const walkUp = (id: string) => {
      for (const dep of upstream.get(id) ?? []) {
        if (!connected.has(dep)) {
          connected.add(dep);
          walkUp(dep);
        }
      }
    };

    // Walk downstream (dependents)
    const walkDown = (id: string) => {
      for (const dep of downstream.get(id) ?? []) {
        if (!connected.has(dep)) {
          connected.add(dep);
          walkDown(dep);
        }
      }
    };

    walkUp(selectedNodeId);
    walkDown(selectedNodeId);
    return connected;
  }, [selectedNodeId, upstream, downstream]);

  // Merge layout with live status and highlight state
  const nodes: Node[] = useMemo(() => {
    return layoutNodes.map((node) => {
      const status: GraphNodeStatus = resolveNodeStatus(
        node.id,
        planStatuses[node.id],
        mergedPlanIds,
      );

      const highlighted = highlightedNodes
        ? highlightedNodes.has(node.id)
          ? true
          : false
        : null;

      return {
        ...node,
        data: {
          ...node.data,
          status,
          highlighted,
        },
      };
    });
  }, [layoutNodes, planStatuses, mergedPlanIds, highlightedNodes]);

  // Merge edges with live status
  const edges: Edge[] = useMemo(() => {
    return layoutEdges.map((edge) => {
      const sourceStatus: GraphNodeStatus = resolveNodeStatus(
        edge.source,
        planStatuses[edge.source],
        mergedPlanIds,
      );
      const targetStatus: GraphNodeStatus = resolveNodeStatus(
        edge.target,
        planStatuses[edge.target],
        mergedPlanIds,
      );

      return {
        ...edge,
        data: {
          ...edge.data,
          sourceStatus,
          targetStatus,
        },
      };
    });
  }, [layoutEdges, planStatuses, mergedPlanIds]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      // Toggle selection: clicking same node clears, clicking different node selects
      setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
    },
    [],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  if (!orchestration) {
    return (
      <div className="flex items-center justify-center h-full text-text-dim text-[11px]">
        No orchestration data available
      </div>
    );
  }

  if (!isLayoutReady) {
    return (
      <div className="flex items-center justify-center h-full text-text-dim text-[11px]">
        Computing layout...
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div className="w-full h-full" style={{ minHeight: 400 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.4, maxZoom: 0.9 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          minZoom={0.3}
          maxZoom={2}
        >
          <Background color="var(--color-border)" gap={20} size={1} />
          <Controls
            showInteractive={false}
            style={{
              background: 'var(--color-card)',
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
            }}
          />
        </ReactFlow>
      </div>
    </TooltipProvider>
  );
}
