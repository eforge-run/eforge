import { useState, useEffect, useCallback, useRef } from 'react';

import { AppLayout } from '@/components/layout/app-layout';
import { Header } from '@/components/layout/header';
import { Sidebar } from '@/components/layout/sidebar';
import { SummaryCards } from '@/components/common/summary-cards';
import { ActivityHeatstrip } from '@/components/common/activity-heatstrip';
import { Pipeline } from '@/components/pipeline/pipeline';
import { Timeline } from '@/components/timeline/timeline';
import { PlanCards } from '@/components/plans/plan-cards';
import { DependencyGraph } from '@/components/graph';
import { FileHeatmap } from '@/components/heatmap';
import { PlanPreviewProvider, PlanPreviewPanel } from '@/components/preview';
import { useEforgeEvents } from '@/hooks/use-eforge-events';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { getSummaryStats } from '@/lib/reducer';
import { fetchLatestRunId, fetchOrchestration } from '@/lib/api';
import type { OrchestrationConfig } from '@/lib/types';

type ContentTab = 'plans' | 'timeline' | 'graph' | 'heatmap';

export function App() {
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState<ContentTab>('plans');
  const [orchestration, setOrchestration] = useState<OrchestrationConfig | null>(null);
  const [mergedPlanIds, setMergedPlanIds] = useState<Set<string>>(new Set());
  const knownLatestRef = useRef<string | null>(null);
  const userSelectedRunRef = useRef<string | null>(null);
  const { runState, connectionStatus } = useEforgeEvents(currentRunId);
  const { containerRef, autoScroll, enableAutoScroll } = useAutoScroll([runState.events.length]);

  const stats = getSummaryStats(runState);
  const hasEvents = runState.events.length > 0;
  const isMultiPlan = Object.keys(runState.planStatuses).length > 1;
  const hasPlans = runState.events.some((e) => e.event.type === 'plan:complete');

  // Select run handler — marks as user-selected to prevent auto-switch
  const handleSelectRun = useCallback((runId: string) => {
    userSelectedRunRef.current = runId;
    setCurrentRunId(runId);
    setSidebarRefresh((c) => c + 1);
  }, []);

  // Clear user selection when the watched run completes
  useEffect(() => {
    if (runState.isComplete && userSelectedRunRef.current === currentRunId) {
      userSelectedRunRef.current = null;
    }
  }, [runState.isComplete, currentRunId]);

  // Poll for new runs — only auto-switch when no user selection is active
  useEffect(() => {
    // Auto-select latest run on mount
    fetchLatestRunId().then((id) => {
      if (id) {
        knownLatestRef.current = id;
        if (!currentRunId) {
          setCurrentRunId(id);
        }
      }
    }).catch(() => {});

    const interval = setInterval(async () => {
      try {
        const latestId = await fetchLatestRunId();
        if (latestId && latestId !== knownLatestRef.current) {
          knownLatestRef.current = latestId;
          // Refresh sidebar to show new run, but only auto-switch if user hasn't manually selected
          setSidebarRefresh((c) => c + 1);
          if (!userSelectedRunRef.current) {
            setCurrentRunId(latestId);
          }
        }
      } catch {
        // ignore
      }
    }, 2000);

    return () => clearInterval(interval);
  }, []); // Run once on mount — no dependency on currentRunId

  // Refresh sidebar when phase:start or phase:end events arrive
  useEffect(() => {
    const lastEvent = runState.events[runState.events.length - 1];
    if (lastEvent) {
      const type = lastEvent.event.type;
      if (type === 'phase:start' || type === 'phase:end') {
        setSidebarRefresh((c) => c + 1);
      }
    }
  }, [runState.events.length]);

  // Fetch orchestration data when run changes
  useEffect(() => {
    if (!currentRunId) {
      setOrchestration(null);
      return;
    }
    fetchOrchestration(currentRunId)
      .then((data) => setOrchestration(data as OrchestrationConfig))
      .catch(() => setOrchestration(null));
  }, [currentRunId]);

  // Track merged plan IDs from events
  useEffect(() => {
    const merged = new Set<string>();
    for (const { event } of runState.events) {
      if (event.type === 'merge:complete' && 'planId' in event) {
        merged.add((event as { planId: string }).planId);
      }
    }
    // Only update state if the set actually changed
    setMergedPlanIds((prev) => {
      if (prev.size === merged.size && [...merged].every((id) => prev.has(id))) return prev;
      return merged;
    });
  }, [runState.events.length]);

  const hasOrchestration = orchestration !== null && orchestration.plans.length > 0;
  const graphEnabled = hasOrchestration;
  const heatmapEnabled = isMultiPlan;

  // Reset active tab if its feature becomes unavailable
  useEffect(() => {
    if (activeTab === 'graph' && !graphEnabled) setActiveTab('plans');
    if (activeTab === 'heatmap' && !heatmapEnabled) setActiveTab('plans');
  }, [graphEnabled, heatmapEnabled, activeTab]);

  // Update duration every second while running
  const [, setTick] = useState(0);
  useEffect(() => {
    if (runState.startTime && !runState.isComplete) {
      const timer = setInterval(() => setTick((t) => t + 1), 1000);
      return () => clearInterval(timer);
    }
  }, [runState.startTime, runState.isComplete]);

  const tabClass = (tab: ContentTab, enabled = true) =>
    `px-4 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
      activeTab === tab
        ? 'border-primary text-foreground'
        : enabled
          ? 'border-transparent text-text-dim hover:text-foreground'
          : 'border-transparent text-text-dim/40 cursor-default'
    }`;

  return (
    <PlanPreviewProvider>
      <AppLayout
        header={<Header connectionStatus={connectionStatus} />}
        sidebar={
          <Sidebar
            currentRunId={currentRunId}
            onSelectRun={handleSelectRun}
            refreshTrigger={sidebarRefresh}
          />
        }
      >
        <main
          ref={containerRef}
          className="overflow-y-auto px-6 py-5 flex flex-col gap-4 flex-1"
        >
          {!hasEvents ? (
            <div className="flex items-center justify-center h-full text-text-dim text-sm">
              Waiting for events...
            </div>
          ) : (
            <>
              <SummaryCards {...stats} isComplete={runState.resultStatus === 'completed'} isFailed={runState.resultStatus === 'failed'} />
              <ActivityHeatstrip events={runState.events} startTime={runState.startTime} />
              <Pipeline planStatuses={runState.planStatuses} reviewIssues={runState.reviewIssues} />

              {/* Content tabs */}
              <div className="flex gap-2 border-b border-border pb-px">
                <button onClick={() => setActiveTab('plans')} className={tabClass('plans')}>
                  Plans
                </button>
                <button onClick={() => setActiveTab('timeline')} className={tabClass('timeline')}>
                  Timeline
                </button>
                <button
                  onClick={() => setActiveTab('graph')}
                  disabled={!graphEnabled}
                  className={tabClass('graph', graphEnabled)}
                  title={graphEnabled ? undefined : 'Available for multi-plan runs with orchestration'}
                >
                  Graph
                </button>
                <button
                  onClick={() => setActiveTab('heatmap')}
                  disabled={!heatmapEnabled}
                  className={tabClass('heatmap', heatmapEnabled)}
                  title={heatmapEnabled ? undefined : 'Available for multi-plan runs'}
                >
                  Heatmap
                </button>
              </div>

              {/* Tab content */}
              {activeTab === 'plans' ? (
                hasPlans ? (
                  <PlanCards
                    runId={currentRunId}
                    planStatuses={runState.planStatuses}
                    fileChanges={runState.fileChanges}
                  />
                ) : (
                  <div className="text-text-dim text-xs py-8 text-center">
                    Plans will appear here once generated...
                  </div>
                )
              ) : activeTab === 'graph' && graphEnabled ? (
                <div className="flex-1" style={{ minHeight: 400 }}>
                  <DependencyGraph
                    orchestration={orchestration}
                    planStatuses={runState.planStatuses}
                    mergedPlanIds={mergedPlanIds}
                  />
                </div>
              ) : activeTab === 'heatmap' && heatmapEnabled ? (
                <FileHeatmap runState={runState} />
              ) : (
                <Timeline
                  events={runState.events}
                  startTime={runState.startTime}
                  waves={runState.waves}
                  planStatuses={runState.planStatuses}
                />
              )}
            </>
          )}
        </main>

        {/* Auto-scroll button */}
        {!autoScroll && hasEvents && (
          <button
            onClick={enableAutoScroll}
            className="fixed bottom-4 right-4 bg-bg-tertiary border border-border rounded-md px-3 py-1.5 text-[11px] text-text-dim cursor-pointer hover:text-foreground"
          >
            ↓ Auto-scroll
          </button>
        )}

        <PlanPreviewPanel runId={currentRunId} />
      </AppLayout>
    </PlanPreviewProvider>
  );
}
