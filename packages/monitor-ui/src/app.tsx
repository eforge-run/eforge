import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { usePanelRef, useDefaultLayout } from 'react-resizable-panels';

import { AppLayout } from '@/components/layout/app-layout';
import { Header } from '@/components/layout/header';
import { Sidebar } from '@/components/layout/sidebar';
import { ShutdownBanner } from '@/components/layout/shutdown-banner';
import { SummaryCards } from '@/components/common/summary-cards';
import { FailureBanner } from '@/components/common/failure-banner';
import { ThreadPipeline } from '@/components/pipeline/thread-pipeline';
import { Timeline } from '@/components/timeline/timeline';
import { DependencyGraph } from '@/components/graph';
import { FileHeatmap } from '@/components/heatmap';
import { PlanPreviewProvider, PlanPreviewPanel, usePlanPreview } from '@/components/preview';
import { ConsolePanel, type LowerTab } from '@/components/console/console-panel';
import { PlanTab } from '@/components/console/plan-tab';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { useEforgeEvents } from '@/hooks/use-eforge-events';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { useAutoBuild } from '@/hooks/use-auto-build';
import { getSummaryStats } from '@/lib/reducer';
import { fetchLatestSessionId, fetchOrchestration, fetchProjectContext } from '@/lib/api';
import type { OrchestrationConfig, PipelineStage, EforgeEvent } from '@/lib/types';
import type { ProjectContext } from '@/components/layout/header';

function AppContent() {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [lowerTab, setLowerTab] = useState<LowerTab>('log');
  const [orchestration, setOrchestration] = useState<OrchestrationConfig | null>(null);
  const [mergedPlanIds, setMergedPlanIds] = useState<Set<string>>(new Set());
  const [showVerbose, setShowVerbose] = useState(false);
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const consolePanelRef = usePanelRef();
  const knownLatestRef = useRef<string | null>(null);
  const userSelectedRef = useRef<string | null>(null);
  const isCurrentRunningRef = useRef(false);
  const { runState, connectionStatus, shutdownCountdown } = useEforgeEvents(currentSessionId);
  const { containerRef, autoScroll, enableAutoScroll } = useAutoScroll([runState.events.length]);
  const { state: autoBuildState, toggling: autoBuildToggling, toggle: onToggleAutoBuild } = useAutoBuild();
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { setRuntimeData } = usePlanPreview();

  // Fetch project context once on mount
  useEffect(() => {
    fetchProjectContext()
      .then(setProjectContext)
      .catch(() => {});
  }, []);

  // Sync runtime data into PlanPreviewContext
  useEffect(() => {
    setRuntimeData({
      planStatuses: runState.planStatuses,
      fileChanges: runState.fileChanges,
      moduleStatuses: runState.moduleStatuses,
    });
  }, [runState.planStatuses, runState.fileChanges, runState.moduleStatuses, setRuntimeData]);

  // Persist panel layout to localStorage
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'monitor-layout-v2',
  });

  const stats = getSummaryStats(runState);
  const hasEvents = runState.events.length > 0;
  const hasPlans = runState.events.some((e) => e.event.type === 'planning:complete');
  const hasExpeditionContent = runState.expeditionModules.length > 0;

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

  // Track whether the current session is actively running (for auto-switch suppression).
  // Uses a ref so the polling interval closure reads fresh state.
  useEffect(() => {
    isCurrentRunningRef.current = runState.events.length > 0 && !runState.isComplete;
  }, [runState.events.length, runState.isComplete]);

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
          // Auto-switch only when the user hasn't explicitly selected a session
          // AND the current session isn't actively running (prevents enqueue/format
          // runs from stealing focus from an in-progress build).
          if (!userSelectedRef.current && !isCurrentRunningRef.current) {
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
      if (event.type === 'plan:merge:complete' && 'planId' in event) {
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
  const hasDependencyEdges = effectiveOrchestration !== null && effectiveOrchestration.plans.some((p: { dependsOn?: string[] }) => p.dependsOn && p.dependsOn.length > 0);
  const graphEnabled = hasOrchestration && hasDependencyEdges;

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

  // Derive PRD source from the first plan:start event
  const prdSource = useMemo(() => {
    const planStart = runState.events.find((e) => e.event.type === 'planning:start');
    if (!planStart || planStart.event.type !== 'planning:start') return null;
    return { label: planStart.event.label ?? 'Build PRD', content: planStart.event.source };
  }, [runState.events]);

  // Derive plan artifacts from plan:complete events
  const planArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const plans: Array<{ id: string; name: string; body: string }> = [];
    for (const { event } of runState.events) {
      if (event.type === 'planning:complete') {
        for (const p of event.plans) {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            plans.push({ id: p.id, name: p.name, body: p.body });
          }
        }
      }
      if (event.type === 'gap_close:plan_ready' && !seen.has('gap-close')) {
        seen.add('gap-close');
        plans.push({ id: 'gap-close', name: 'PRD Gap Close', body: (event as { planBody: string }).planBody });
      }
    }
    return plans;
  }, [runState.events]);

  // Derive build failures from build:failed events
  const buildFailures = useMemo(() => {
    const failures: Array<{ planId: string; error: string }> = [];
    for (const { event } of runState.events) {
      if (event.type === 'plan:build:failed') {
        failures.push({ planId: event.planId, error: event.error });
      }
    }
    return failures;
  }, [runState.events]);

  // Derive phase summary from the last failed phase:end event
  const phaseSummary = useMemo(() => {
    for (let i = runState.events.length - 1; i >= 0; i--) {
      const { event } = runState.events[i];
      if (event.type === 'phase:end' && event.result.status === 'failed') {
        return event.result.summary;
      }
    }
    return null;
  }, [runState.events]);

  const planEnabled = effectiveOrchestration !== null;

  // Reset lower tab if graph or plan becomes unavailable
  useEffect(() => {
    if (lowerTab === 'graph' && !graphEnabled) setLowerTab('log');
  }, [graphEnabled, lowerTab]);

  useEffect(() => {
    if (lowerTab === 'plan' && !planEnabled) setLowerTab('log');
  }, [planEnabled, lowerTab]);

  // Derive the latest planning:pipeline event for the Plan tab
  const latestPipelineEvent = useMemo(() => {
    for (let i = runState.events.length - 1; i >= 0; i--) {
      const { event } = runState.events[i];
      if (event.type === 'planning:pipeline') {
        return event as EforgeEvent & { type: 'planning:pipeline' };
      }
    }
    return null;
  }, [runState.events]);

  // Update duration every second while running
  const [, setTick] = useState(0);
  useEffect(() => {
    if (runState.startTime && !runState.isComplete) {
      const timer = setInterval(() => setTick((t) => t + 1), 1000);
      return () => clearInterval(timer);
    }
  }, [runState.startTime, runState.isComplete]);

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
    <AppLayout
      sidebarCollapsed={sidebarCollapsed}
      header={<Header connectionStatus={connectionStatus} autoBuildState={autoBuildState} autoBuildToggling={autoBuildToggling} onToggleAutoBuild={onToggleAutoBuild} projectContext={projectContext} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed(prev => !prev)} />}
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
        {/* Upper panel: pipeline */}
        <ResizablePanel id="upper" defaultSize={65} minSize={30}>
          <main className="overflow-y-auto px-6 py-3 flex flex-col gap-4 h-full">
            {!hasEvents ? (
              <div className="flex items-center justify-center h-full text-text-dim text-sm">
                Waiting for events...
              </div>
            ) : (
              <>
                <SummaryCards {...stats} isComplete={runState.resultStatus === 'completed'} isFailed={runState.resultStatus === 'failed'} harness={runState.harness} />
                <ThreadPipeline agentThreads={runState.agentThreads} startTime={runState.startTime} endTime={runState.endTime} planStatuses={runState.planStatuses} reviewIssues={runState.reviewIssues} profileInfo={runState.profileInfo} events={runState.events} orchestration={effectiveOrchestration} prdSource={prdSource} planArtifacts={planArtifacts} />
                <FailureBanner failures={buildFailures} phaseSummary={phaseSummary} />
              </>
            )}
          </main>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Lower panel: Log / Changes / Graph */}
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
            activeTab={lowerTab}
            onTabChange={setLowerTab}
            graphEnabled={graphEnabled}
            planEnabled={planEnabled}
            showVerbose={showVerbose}
            onToggleVerbose={setShowVerbose}
            collapsed={consoleCollapsed}
            onToggleCollapse={handleToggleConsole}
            scrollRef={containerRef}
            autoScroll={autoScroll}
            onEnableAutoScroll={enableAutoScroll}
          >
            {lowerTab === 'log' ? (
              <Timeline
                events={runState.events}
                startTime={runState.startTime}
                showVerbose={showVerbose}
              />
            ) : lowerTab === 'changes' ? (
              runState.fileChanges.size > 0 ? (
                <FileHeatmap runState={runState} sessionId={currentSessionId} />
              ) : (
                <div className="text-text-dim text-xs py-8 text-center">
                  Changes will appear here once files are modified...
                </div>
              )
            ) : lowerTab === 'graph' && graphEnabled ? (
              <div className="h-full w-full">
                <DependencyGraph
                  orchestration={effectiveOrchestration}
                  planStatuses={graphPlanStatuses}
                  mergedPlanIds={mergedPlanIds}
                />
              </div>
            ) : lowerTab === 'plan' && planEnabled ? (
              <PlanTab
                orchestration={effectiveOrchestration}
                pipelineEvent={latestPipelineEvent}
              />
            ) : null}
          </ConsolePanel>
        </ResizablePanel>
      </ResizablePanelGroup>

      <PlanPreviewPanel sessionId={currentSessionId} />
    </AppLayout>
  );
}

export function App() {
  return (
    <PlanPreviewProvider>
      <AppContent />
    </PlanPreviewProvider>
  );
}
