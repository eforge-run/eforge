import { useState, useEffect, useCallback, useRef } from 'react';

import { AppLayout } from '@/components/layout/app-layout';
import { Header } from '@/components/layout/header';
import { Sidebar } from '@/components/layout/sidebar';
import { SummaryCards } from '@/components/common/summary-cards';
import { Pipeline } from '@/components/pipeline/pipeline';
import { Timeline } from '@/components/timeline/timeline';
import { useEforgeEvents } from '@/hooks/use-eforge-events';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { getSummaryStats } from '@/lib/reducer';
import { fetchLatestRunId } from '@/lib/api';

export function App() {
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
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
        className="overflow-y-auto p-4 flex flex-col gap-4"
      >
        {!hasEvents ? (
          <div className="flex items-center justify-center h-full text-text-dim text-sm">
            Waiting for events...
          </div>
        ) : (
          <>
            <SummaryCards {...stats} />
            <Pipeline planStatuses={runState.planStatuses} />
            <Timeline
              events={runState.events}
              startTime={runState.startTime}
              waves={runState.waves}
              planStatuses={runState.planStatuses}
            />
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
