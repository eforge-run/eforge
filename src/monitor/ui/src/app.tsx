import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { usePanelRef, useDefaultLayout } from 'react-resizable-panels';

import { AppLayout } from '@/components/layout/app-layout';
import { Header } from '@/components/layout/header';
import { Sidebar } from '@/components/layout/sidebar';
import { ShutdownBanner } from '@/components/layout/shutdown-banner';
import { SummaryCards } from '@/components/common/summary-cards';
import { ThreadPipeline } from '@/components/pipeline/thread-pipeline';
import { Timeline } from '@/components/timeline/timeline';
import { PlanCards } from '@/components/plans/plan-cards';
import { DependencyGraph } from '@/components/graph';
import { FileHeatmap } from '@/components/heatmap';
import { PlanPreviewProvider, PlanPreviewPanel } from '@/components/preview';
import { ConsolePanel } from '@/components/console/console-panel';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { useEforgeEvents } from '@/hooks/use-eforge-events';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { useAutoBuild } from '@/hooks/use-auto-build';
import { getSummaryStats } from '@/lib/reducer';
import { fetchLatestSessionId, fetchOrchestration, fetchProjectContext } from '@/lib/api';
import type { OrchestrationConfig, PipelineStage } from '@/lib/types';
import type { ProjectContext } from '@/components/layout/header';

type ContentTab = 'plans' | 'graph' | 'changes';

export function App() {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState<ContentTab>('plans');
  const [orchestration, setOrchestration] = useState<OrchestrationConfig | null>(null);
  const [mergedPlanIds, setMergedPlanIds] = useState<Set<string>>(new Set());
  const [showVerbose, setShowVerbose] = useState(false);
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const consolePanelRef = usePanelRef();
  const knownLatestRef = useRef<string | null>(null);
  const userSelectedRef = useRef<string | null>(null);
  const { runState, connectionStatus, shutdownCountdown } = useEforgeEvents(currentSessionId);
  const { containerRef, autoScroll, enableAutoScroll } = useAutoScroll([runState.events.length]);
  const { state: autoBuildState, toggling: autoBuildToggling, toggle: onToggleAutoBuild } = useAutoBuild();
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);

  // Fetch project context once on mount
  useEffect(() => {
    fetchProjectContext()
      .then(setProjectContext)
      .catch(() => {});
  }, []);

  // Persist panel layout to localStorage
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'monitor-console',
  });

  const stats = getSummaryStats(runState);
  const hasEvents = runState.events.length > 0;
  const isMultiPlan = Object.keys(runState.planStatuses).length > 1;
  const hasPlans = runState.events.some((e) => e.event.type === 'plan:complete');
  const hasExpeditionContent = runState.expeditionModules.length > 0;
  const hasAnyPlanContent = hasPlans || hasExpeditionContent;

  // Refetch trigger for expedition files — increments as modules complete.
  // Derive from a stable string key to avoid recomputing on every SSE event
  // (the reducer spreads moduleStatuses into a new object on each ADD_EVENT).
  const completedModuleKey = useMemo(
    () => Object.entries(runState.moduleStatuses)
      .filter(([, s]) => s === 'complete')
      .map(([id]) => id)
      .sort()
      .join(','),
    [runState.moduleStatuses],
  );
  const expeditionRefetchTrigger = useMemo(() => {
    if (!hasExpeditionContent) return 0;
    const completedCount = completedModuleKey ? completedModuleKey.split(',').length : 0;
    return completedCount + 1; // +1 so architecture shows up immediately
  }, [hasExpeditionContent, completedModuleKey]);

  // Select session handler — marks as user-selected to prevent auto-switch
  const handleSelectSession = useCallback((sessionId: string) => {
    userSelectedRef.current = sessionId;
    setCurrentSessionId(sessionId);
    setSidebarRefresh((c) => c + 1);
  }, []);

  // Clear user selection when the watched session completes
  useEffect(() => {
    if (runState.isComplete && userSelectedRef.current === currentSessionId) {
      userSelectedRef.current = null;
    }
  }, [runState.isComplete, currentSessionId]);

  // Poll for new sessions — only auto-switch when no user selection is active
  useEffect(() => {
    // Auto-select latest session on mount
    fetchLatestSessionId().then((id) => {
      if (id) {
        knownLatestRef.current = id;
        if (!currentSessionId) {
          setCurrentSessionId(id);
        }
      }
    }).catch(() => {});

    const interval = setInterval(async () => {
      try {
        const latestId = await fetchLatestSessionId();
        // Refresh sidebar on every poll cycle so DB state changes (enqueue completion,
        // phase transitions, status updates) are reflected without a browser refresh.
        setSidebarRefresh((c) => c + 1);
        if (latestId && latestId !== knownLatestRef.current) {
          knownLatestRef.current = latestId;
          if (!userSelectedRef.current) {
            setCurrentSessionId(latestId);
          }
        }
      } catch {
        // ignore
      }
    }, 2000);

    return () => clearInterval(interval);
  }, []); // Run once on mount — no dependency on currentSessionId

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

  // Refresh sidebar when session completes — immune to React 18 batching
  // since isComplete is a stable derived boolean, not dependent on event ordering
  useEffect(() => {
    if (runState.isComplete) {
      setSidebarRefresh((c) => c + 1);
    }
  }, [runState.isComplete]);

  // Fetch orchestration data when session changes
  useEffect(() => {
    if (!currentSessionId) {
      setOrchestration(null);
      return;
    }
    fetchOrchestration(currentSessionId)
      .then((data) => setOrchestration(data as OrchestrationConfig))
      .catch(() => setOrchestration(null));
  }, [currentSessionId, hasPlans]);

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

  // Use early orchestration (from expedition:architecture:complete) until server-fetched data arrives
  const effectiveOrchestration = orchestration ?? runState.earlyOrchestration;
  const hasOrchestration = effectiveOrchestration !== null && effectiveOrchestration.plans.length > 0;
  const hasDependencyEdges = effectiveOrchestration !== null && effectiveOrchestration.plans.some((p) => p.dependsOn && p.dependsOn.length > 0);
  const graphEnabled = hasOrchestration && hasDependencyEdges;
  const changesEnabled = runState.fileChanges.size > 0;

  // During compile phase, map module statuses to pipeline stages so the graph
  // can reuse its existing node color system before real orchestration data arrives.
  // 'planning' → 'implement' gives an animated blue node (active work).
  // 'complete' → 'plan' gives a static completed-plan look.
  // 'pending' is intentionally unmapped — the graph treats missing keys as pending.
  const isCompilePhase = orchestration === null;
  const graphPlanStatuses = useMemo((): Record<string, PipelineStage> => {
    if (!isCompilePhase) return runState.planStatuses;
    const synthetic: Record<string, PipelineStage> = { ...runState.planStatuses };
    for (const [moduleId, status] of Object.entries(runState.moduleStatuses)) {
      if (status === 'planning') synthetic[moduleId] = 'implement';
      else if (status === 'complete') synthetic[moduleId] = 'plan';
    }
    return synthetic;
  }, [isCompilePhase, runState.planStatuses, runState.moduleStatuses]);

  // Reset active tab if its feature becomes unavailable
  useEffect(() => {
    if (activeTab === 'graph' && !graphEnabled) setActiveTab('plans');
    if (activeTab === 'changes' && !changesEnabled) setActiveTab('plans');
  }, [graphEnabled, changesEnabled, activeTab]);

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

  const handleToggleConsole = useCallback(() => {
    const panel = consolePanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [consolePanelRef]);

  // Detect collapse/expand via onResize
  const handleConsolePanelResize = useCallback(
    (panelSize: { asPercentage: number }) => {
      const panel = consolePanelRef.current;
      if (panel) {
        setConsoleCollapsed(panel.isCollapsed());
      }
    },
    [consolePanelRef],
  );

  return (
    <PlanPreviewProvider>
      <AppLayout
        header={<Header connectionStatus={connectionStatus} autoBuildState={autoBuildState} autoBuildToggling={autoBuildToggling} onToggleAutoBuild={onToggleAutoBuild} projectContext={projectContext} />}
        sidebar={
          <Sidebar
            currentSessionId={currentSessionId}
            onSelectSession={handleSelectSession}
            refreshTrigger={sidebarRefresh}
            daemonActive={autoBuildState !== null}
          />
        }
      >
        {shutdownCountdown !== null && <ShutdownBanner countdown={shutdownCountdown} />}
        <ResizablePanelGroup orientation="vertical" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
          {/* Upper panel: summary + tabs */}
          <ResizablePanel id="upper" defaultSize={65} minSize={30}>
            <main className="overflow-y-auto px-6 py-3 flex flex-col gap-4 h-full">
              {!hasEvents ? (
                <div className="flex items-center justify-center h-full text-text-dim text-sm">
                  Waiting for events...
                </div>
              ) : (
                <>
                  <SummaryCards {...stats} isComplete={runState.resultStatus === 'completed'} isFailed={runState.resultStatus === 'failed'} />
                  <ThreadPipeline agentThreads={runState.agentThreads} startTime={runState.startTime} endTime={runState.endTime} planStatuses={runState.planStatuses} reviewIssues={runState.reviewIssues} profileInfo={runState.profileInfo} events={runState.events} />

                  {/* Content tabs */}
                  <div className="flex gap-2 border-b border-border pb-px">
                    <button
                      onClick={() => setActiveTab('changes')}
                      disabled={!changesEnabled}
                      className={tabClass('changes', changesEnabled)}
                      title={changesEnabled ? undefined : 'Available after files are modified'}
                    >
                      Changes
                    </button>
                    <button onClick={() => setActiveTab('plans')} className={tabClass('plans')}>
                      Plans
                    </button>
                    <button
                      onClick={() => setActiveTab('graph')}
                      disabled={!graphEnabled}
                      className={tabClass('graph', graphEnabled)}
                      title={graphEnabled ? undefined : 'Available when plans have dependency edges'}
                    >
                      Graph
                    </button>
                  </div>

                  {/* Tab content */}
                  {activeTab === 'plans' ? (
                    hasAnyPlanContent ? (
                      <PlanCards
                        sessionId={currentSessionId}
                        planStatuses={runState.planStatuses}
                        fileChanges={runState.fileChanges}
                        moduleStatuses={runState.moduleStatuses}
                        refetchTrigger={expeditionRefetchTrigger}
                      />
                    ) : (
                      <div className="text-text-dim text-xs py-8 text-center">
                        Plans will appear here once generated...
                      </div>
                    )
                  ) : activeTab === 'graph' && graphEnabled ? (
                    <div className="flex-1" style={{ minHeight: 400 }}>
                      <DependencyGraph
                        orchestration={effectiveOrchestration}
                        planStatuses={graphPlanStatuses}
                        mergedPlanIds={mergedPlanIds}
                      />
                    </div>
                  ) : activeTab === 'changes' && changesEnabled ? (
                    <div className="flex-1 min-h-0">
                      <FileHeatmap runState={runState} sessionId={currentSessionId} />
                    </div>
                  ) : null}
                </>
              )}
            </main>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Lower panel: Console (Timeline) */}
          <ResizablePanel
            id="console"
            panelRef={consolePanelRef}
            defaultSize={35}
            minSize={5}
            collapsible
            collapsedSize={5}
            onResize={handleConsolePanelResize}
          >
            <ConsolePanel
              showVerbose={showVerbose}
              onToggleVerbose={setShowVerbose}
              collapsed={consoleCollapsed}
              onToggleCollapse={handleToggleConsole}
              scrollRef={containerRef}
              autoScroll={autoScroll}
              onEnableAutoScroll={enableAutoScroll}
            >
              <Timeline
                events={runState.events}
                startTime={runState.startTime}
                showVerbose={showVerbose}
              />
            </ConsolePanel>
          </ResizablePanel>
        </ResizablePanelGroup>

        <PlanPreviewPanel sessionId={currentSessionId} />
      </AppLayout>
    </PlanPreviewProvider>
  );
}
