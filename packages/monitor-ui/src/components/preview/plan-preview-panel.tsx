import { useEffect } from 'react';
import { usePlanPreview } from './plan-preview-context';
import { PlanMetadata } from './plan-metadata';
import { PlanBodyHighlight } from './plan-body-highlight';
import { BuildConfigSection } from '@/components/plans/build-config';
import { StatusBadge, ModuleStatusBadge } from '@/components/plans/plan-card';
import { splitPlanContent, parseFrontmatterFields } from '@/lib/plan-content';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PlanData } from '@/lib/types';
import { API_ROUTES, buildPath } from '@eforge-build/client/browser';

interface PlanPreviewPanelProps {
  sessionId: string | null;
}

export function PlanPreviewPanel({ sessionId }: PlanPreviewPanelProps) {
  const { selectedPlanId, contentPreview, closePreview, planStatuses, fileChanges, moduleStatuses } = usePlanPreview();
  const isOpen = selectedPlanId !== null || contentPreview !== null;
  const { data: plans, loading, error } = useApi<PlanData[]>(
    selectedPlanId && sessionId ? buildPath(API_ROUTES.plans, { runId: sessionId }) : null,
  );

  // Find selected plan
  const selectedPlan = plans?.find((p) => p.id === selectedPlanId) ?? null;
  const planType = selectedPlan?.type ?? 'plan';

  // Parse frontmatter from body for metadata (only for compiled plans)
  const metadata = selectedPlan && planType === 'plan'
    ? (() => {
        const { frontmatter } = splitPlanContent(selectedPlan.body);
        if (frontmatter) {
          const parsed = parseFrontmatterFields(frontmatter);
          return {
            id: parsed.id || selectedPlan.id,
            name: parsed.name || selectedPlan.name,
            dependsOn: parsed.dependsOn,
            branch: parsed.branch,
            migrations: parsed.migrations.length > 0 ? parsed.migrations : undefined,
          };
        }
        return {
          id: selectedPlan.id,
          name: selectedPlan.name,
          dependsOn: [],
          branch: '',
          migrations: undefined,
        };
      })()
    : null;

  // Runtime data for selected plan
  const planStatus = selectedPlanId ? planStatuses[selectedPlanId] : undefined;
  const planFileChanges = selectedPlanId ? fileChanges.get(selectedPlanId) : undefined;
  const moduleStatus = selectedPlanId ? moduleStatuses[selectedPlanId] : undefined;

  // Escape key to close
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closePreview();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closePreview]);

  return (
    <>
      {/* Backdrop overlay */}
      <div
        className={cn(
          'fixed inset-0 bg-black/50 z-40 transition-opacity duration-300',
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        onClick={closePreview}
      />

      {/* Slide-out panel */}
      <div
        className={cn(
          'fixed top-0 right-0 h-full w-[640px] max-w-[90vw] bg-card border-l border-border z-50',
          'flex flex-col transition-transform duration-300 ease-in-out',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            {planType !== 'plan' && (
              <span className={cn(
                'text-[10px] font-medium px-1.5 py-0.5 rounded-sm shrink-0',
                planType === 'architecture' ? 'bg-cyan/15 text-cyan' : 'bg-yellow/15 text-yellow',
              )}>
                {planType === 'architecture' ? 'Architecture' : 'Module'}
              </span>
            )}
            <h2 className="text-sm font-semibold text-foreground truncate">
              {contentPreview?.title ?? selectedPlan?.name ?? 'Plan Preview'}
            </h2>
            {selectedPlan && planType === 'plan' && <StatusBadge status={planStatus} />}
            {selectedPlan && planType === 'module' && <ModuleStatusBadge status={moduleStatus} />}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={closePreview}
            className="h-auto w-auto p-1 text-lg leading-none"
            aria-label="Close preview"
          >
            &times;
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {contentPreview && (
            <PlanBodyHighlight content={contentPreview.content} />
          )}

          {!contentPreview && loading && (
            <div className="flex items-center gap-2 text-text-dim text-xs py-8 justify-center">
              <div className="w-4 h-4 border-2 border-text-dim border-t-transparent rounded-full animate-spin" />
              Loading plan data...
            </div>
          )}

          {!contentPreview && error && (
            <div className="text-red text-xs py-4 text-center">
              Failed to load plans: {error.message}
            </div>
          )}

          {!contentPreview && !loading && !error && !selectedPlan && selectedPlanId && (
            <div className="text-text-dim text-xs py-4 text-center">
              Plan "{selectedPlanId}" not found.
            </div>
          )}

          {!contentPreview && !loading && !error && selectedPlan && (
            <>
              {metadata && <PlanMetadata {...metadata} />}
              <BuildConfigSection build={selectedPlan.build} review={selectedPlan.review} />
              {planFileChanges && planFileChanges.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1">Files Changed</div>
                  <div className="flex flex-wrap gap-1">
                    {planFileChanges.map((f) => (
                      <span key={f} className="text-[10px] font-mono bg-bg-tertiary px-1.5 py-0.5 rounded text-text-dim">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <PlanBodyHighlight content={selectedPlan.body} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
