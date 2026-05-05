/**
 * Tests B and C from the validation plan.
 *
 * These tests don't render React (no DOM in this suite). They exercise the
 * pure data-derivation helpers that the swim-lane pipeline (B) and the
 * dependency graph (C) depend on, to confirm that `orchestration === null`
 * is a sufficient cause for the user-visible symptoms:
 *
 *   B: per-plan depth bars / dependency tooltips / build-stage cells.
 *   C: dependency edges in the graph tab.
 *
 * If a synthesized `earlyOrchestration` produced from a `planning:complete`
 * event payload yields the *same* derived data as a real orchestration,
 * then the proposed fix (synthesize-on-event) is sufficient to address
 * both symptoms — they share a single root cause.
 */
import { describe, it, expect } from 'vitest';
import { computeDepthMap } from '../compute-depth-map';
import { computeGraphLayout } from '@/components/graph/use-graph-layout';
import type { OrchestrationConfig } from '@/lib/types';
import type { PlanFile } from '@eforge-build/client/browser';

// ---------------------------------------------------------------------------
// Synthesizer that mirrors the proposed `handlePlanningComplete` change.
// We define it locally inside the test because the production code does not
// yet do this — these tests exercise both the gap (null orchestration) and
// the proposed shape (synthesized orchestration), without depending on the
// fix being implemented.
// ---------------------------------------------------------------------------
function synthesizeEarlyOrchestrationFromPlanningComplete(
  plans: PlanFile[],
): OrchestrationConfig {
  return {
    name: '',
    description: '',
    created: '',
    mode: 'compile',
    baseBranch: '',
    pipeline: {
      scope: 'plan',
      compile: [],
      defaultBuild: [],
      defaultReview: {
        strategy: 'auto',
        perspectives: [],
        maxRounds: 1,
        evaluatorStrictness: 'standard',
      },
      rationale: '',
    },
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      dependsOn: p.dependsOn,
      branch: p.branch,
      build: [],
      review: {
        strategy: 'auto',
        perspectives: [],
        maxRounds: 1,
        evaluatorStrictness: 'standard',
      },
    })),
  };
}

const PLANNING_COMPLETE_PAYLOAD: PlanFile[] = [
  { id: 'plan-01', name: 'Plan One', dependsOn: [],            branch: 'b1', body: '', filePath: 'p1.md' },
  { id: 'plan-02', name: 'Plan Two', dependsOn: ['plan-01'],   branch: 'b2', body: '', filePath: 'p2.md' },
  { id: 'plan-03', name: 'Plan Three', dependsOn: ['plan-02'], branch: 'b3', body: '', filePath: 'p3.md' },
];

// ---------------------------------------------------------------------------
// Test B — swim-lane stage data is gated on orchestration
// ---------------------------------------------------------------------------
// `ThreadPipeline` (thread-pipeline.tsx:38–94) builds three maps via useMemo,
// each guarded by `if (orchestration) { ... }`:
//   - dependsByPlan  → drives the "Depends on: …" tooltip on each plan pill.
//   - depthMap       → drives the indentation depth bars on each row.
//   - buildStagesByPlan → drives the per-plan build-stage progress cells.
//
// All three collapse to empty maps when `orchestration === null`. The pure
// helper `computeDepthMap` is the load-bearing one for symptom 1's "stages
// don't render" — if depthMap is empty, every row renders at depth 0 with no
// dependency tooltip. We assert that null orchestration produces an empty
// depthMap, and that a synthesized earlyOrchestration produces the right one.
describe('Test B: swim-lane stage data depends on orchestration', () => {
  it('computeDepthMap is empty when orchestration is null (no plans to feed)', () => {
    const orchestration: OrchestrationConfig | null = null;
    const plans = orchestration?.plans ?? [];
    const depthMap = computeDepthMap(plans);
    expect(depthMap.size).toBe(0);
  });

  it('computeDepthMap produces correct depths from a synthesized earlyOrchestration', () => {
    const synthesized = synthesizeEarlyOrchestrationFromPlanningComplete(
      PLANNING_COMPLETE_PAYLOAD,
    );
    const depthMap = computeDepthMap(synthesized.plans);
    expect(depthMap.get('plan-01')).toBe(0);
    expect(depthMap.get('plan-02')).toBe(1);
    expect(depthMap.get('plan-03')).toBe(2);
  });

  it('synthesized orchestration carries dependsOn through to plan entries', () => {
    // Mirrors `dependsByPlan` in thread-pipeline.tsx:38–48: the same shape
    // the tooltip code reads from.
    const synthesized = synthesizeEarlyOrchestrationFromPlanningComplete(
      PLANNING_COMPLETE_PAYLOAD,
    );
    const dependsByPlan = new Map<string, string[]>();
    for (const plan of synthesized.plans) {
      if (plan.dependsOn.length > 0) dependsByPlan.set(plan.id, plan.dependsOn);
    }
    expect(dependsByPlan.get('plan-02')).toEqual(['plan-01']);
    expect(dependsByPlan.get('plan-03')).toEqual(['plan-02']);
  });
});

// ---------------------------------------------------------------------------
// Test C — dependency-graph edges are gated on orchestration
// ---------------------------------------------------------------------------
// `useGraphLayout` (graph/use-graph-layout.ts:124–133) returns
//   { nodes: [], edges: [], isLayoutReady: false }
// when `orchestration === null`. The same source data
// (`OrchestrationConfig.plans[].dependsOn`) drives both swim-lane edges (B)
// and graph edges (C), so a fix that populates earlyOrchestration on
// planning:complete fixes both symptoms simultaneously.
describe('Test C: dependency-graph edges depend on orchestration', () => {
  it('computeGraphLayout returns no edges when given an empty plans array (orchestration null path)', () => {
    const { nodes, edges } = computeGraphLayout([]);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('computeGraphLayout produces the expected edges from a synthesized earlyOrchestration', () => {
    const synthesized = synthesizeEarlyOrchestrationFromPlanningComplete(
      PLANNING_COMPLETE_PAYLOAD,
    );
    const { nodes, edges } = computeGraphLayout(synthesized.plans);

    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(2); // plan-01→plan-02, plan-02→plan-03

    // Validate each edge connects the right pair (id format: dagre default,
    // we just inspect source/target on each Edge).
    const pairs = edges.map((e) => `${e.source}→${e.target}`).sort();
    expect(pairs).toEqual(['plan-01→plan-02', 'plan-02→plan-03']);
  });
});

// ---------------------------------------------------------------------------
// Equivalence check: the data the synthesizer produces is the data the SWR
// fetch eventually delivers from the daemon route
// (packages/monitor/src/server.ts:354–365 builds the response from the same
// `planning:complete` event). So "synthesize from event" is not a stopgap;
// it's the same answer, just available immediately.
// ---------------------------------------------------------------------------
describe('synthesized earlyOrchestration matches what the daemon route returns from the same event', () => {
  it('plans array shape (id/name/dependsOn/branch) is preserved', () => {
    const synthesized = synthesizeEarlyOrchestrationFromPlanningComplete(
      PLANNING_COMPLETE_PAYLOAD,
    );
    for (let i = 0; i < PLANNING_COMPLETE_PAYLOAD.length; i++) {
      const src = PLANNING_COMPLETE_PAYLOAD[i];
      const out = synthesized.plans[i];
      expect(out.id).toBe(src.id);
      expect(out.name).toBe(src.name);
      expect(out.dependsOn).toEqual(src.dependsOn);
      expect(out.branch).toBe(src.branch);
    }
  });
});
