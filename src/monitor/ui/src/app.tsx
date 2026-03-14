import { useState, useEffect, useCallback, useRef } from 'react';

import { AppLayout } from '@/components/layout/app-layout';
import { Header } from '@/components/layout/header';
import { Sidebar } from '@/components/layout/sidebar';
import { SummaryCards } from '@/components/common/summary-cards';
import { Pipeline } from '@/components/pipeline/pipeline';
import { Timeline } from '@/components/timeline/timeline';
import { DependencyGraph } from '@/components/graph';
import { useEforgeEvents } from '@/hooks/use-eforge-events';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { getSummaryStats } from '@/lib/reducer';
import { fetchLatestRunId, fetchOrchestration } from '@/lib/api';
import type { OrchestrationConfig } from '@/lib/types';

type ContentTab = 'timeline' | 'graph';

export function App() {
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState<ContentTab>('timeline');
  const [orchestration, setOrchestration] = useState<OrchestrationConfig | null>(null);
  const [mergedPlanIds, setMergedPlanIds] = useState<Set<string>>(new Set());
  const knownLatestRef = useRef<string | null>(null);
  const { runState, connectionStatus, resetState } = useEforgeEvents(currentRunId);
  const { containerRef, autoScroll, enableAutoScroll } = useAutoScroll([runState.events.length]);

  const stats = getSummaryStats(runState);
  const hasEvents = runState.events.length > 0;

  // Select run handler
  const handleSelectRun = useCallback((runId: string) => {
    setCurrentRunId(runId);
    resetState();
    setSidebarRefresh((c) => c + 1);
  }, [resetState]);

  // Poll for new runs — only auto-switch when a genuinely new run appears
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
          // A genuinely new run appeared — auto-switch to it
          knownLatestRef.current = latestId;
          setCurrentRunId(latestId);
          setSidebarRefresh((c) => c + 1);
        }
      } catch {
        // ignore
      }
    }, 2000);

    return () => clearInterval(interval);
  }, []); // Run once on mount — no dependency on currentRunId

  // Refresh sidebar when eforge:start or eforge:end events arrive
  useEffect(() => {
    const lastEvent = runState.events[runState.events.length - 1];
    if (lastEvent) {
      const type = lastEvent.event.type;
      if (type === 'eforge:start' || type === 'eforge:end') {
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

  // Update duration every second while running
  const [, setTick] = useState(0);
  useEffect(() => {
    if (runState.startTime && !runState.isComplete) {
      const timer = setInterval(() => setTick((t) => t + 1), 1000);
      return () => clearInterval(timer);
    }
  }, [runState.startTime, runState.isComplete]);

  return (
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
        className="overflow-y-auto p-4 flex flex-col gap-4 flex-1"
      >
        {!hasEvents ? (
          <div className="flex items-center justify-center h-full text-text-dim text-sm">
            Waiting for events...
          </div>
        ) : (
          <>
            <SummaryCards {...stats} />
            <Pipeline planStatuses={runState.planStatuses} />

            {/* Content tabs */}
            {hasOrchestration && (
              <div className="flex gap-1 border-b border-border">
                <button
                  onClick={() => setActiveTab('timeline')}
                  className={`px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors ${
                    activeTab === 'timeline'
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-text-dim hover:text-foreground'
                  }`}
                >
                  Timeline
                </button>
                <button
                  onClick={() => setActiveTab('graph')}
                  className={`px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors ${
                    activeTab === 'graph'
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-text-dim hover:text-foreground'
                  }`}
                >
                  Graph
                </button>
              </div>
            )}

            {/* Tab content */}
            {activeTab === 'graph' && hasOrchestration ? (
              <div className="flex-1" style={{ minHeight: 400 }}>
                <DependencyGraph
                  orchestration={orchestration}
                  planStatuses={runState.planStatuses}
                  mergedPlanIds={mergedPlanIds}
                />
              </div>
            ) : (
              <Timeline events={runState.events} startTime={runState.startTime} />
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
    </AppLayout>
  );
}
