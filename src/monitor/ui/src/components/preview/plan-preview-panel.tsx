import { useEffect } from 'react';
import { usePlanPreview } from './plan-preview-context';
import { PlanMetadata } from './plan-metadata';
import { PlanBodyHighlight } from './plan-body-highlight';
import { splitPlanContent, parseFrontmatterFields } from '@/lib/plan-content';
import { useApi } from '@/hooks/use-api';
import { cn } from '@/lib/utils';
import type { PlanData } from '@/lib/types';

interface PlanPreviewPanelProps {
  sessionId: string | null;
}

export function PlanPreviewPanel({ sessionId }: PlanPreviewPanelProps) {
  const { selectedPlanId, closePreview } = usePlanPreview();
  const isOpen = selectedPlanId !== null;
  const { data: plans, loading, error } = useApi<PlanData[]>(
    isOpen && sessionId ? `/api/plans/${sessionId}` : null,
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
              {selectedPlan?.name ?? 'Plan Preview'}
            </h2>
          </div>
          <button
            onClick={closePreview}
            className="bg-transparent border-none text-text-dim hover:text-foreground cursor-pointer text-lg leading-none p-1"
            aria-label="Close preview"
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-text-dim text-xs py-8 justify-center">
              <div className="w-4 h-4 border-2 border-text-dim border-t-transparent rounded-full animate-spin" />
              Loading plan data...
            </div>
          )}

          {error && (
            <div className="text-red text-xs py-4 text-center">
              Failed to load plans: {error.message}
            </div>
          )}

          {!loading && !error && !selectedPlan && selectedPlanId && (
            <div className="text-text-dim text-xs py-4 text-center">
              Plan "{selectedPlanId}" not found.
            </div>
          )}

          {!loading && !error && selectedPlan && (
            <>
              {metadata && <PlanMetadata {...metadata} />}
              <PlanBodyHighlight content={selectedPlan.body} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
