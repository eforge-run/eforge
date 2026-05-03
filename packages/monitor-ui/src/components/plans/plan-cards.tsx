import { useApi } from '@/hooks/use-api';
import { PlanCard } from './plan-card';
import type { PipelineStage, PlanData } from '@/lib/types';
import type { ModuleStatus } from '@/lib/reducer';
import { API_ROUTES, buildPath } from '@eforge-build/client/browser';

interface PlanCardsProps {
  sessionId: string | null;
  planStatuses: Record<string, PipelineStage>;
  fileChanges: Map<string, string[]>;
  moduleStatuses?: Record<string, ModuleStatus>;
  refetchTrigger?: number;
}

export function PlanCards({ sessionId, planStatuses, fileChanges, moduleStatuses, refetchTrigger }: PlanCardsProps) {
  const { data: plans, loading, error } = useApi<PlanData[]>(
    sessionId ? `${buildPath(API_ROUTES.plans, { runId: sessionId })}${refetchTrigger ? `?t=${refetchTrigger}` : ''}` : null,
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-text-dim text-xs py-8 justify-center">
        <div className="w-4 h-4 border-2 border-text-dim border-t-transparent rounded-full animate-spin" />
        Loading plans...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-red text-xs py-4 text-center">
        Failed to load plans: {error.message}
      </div>
    );
  }

  if (!plans || plans.length === 0) {
    return (
      <div className="text-text-dim text-xs py-8 text-center">
        No plans generated yet.
      </div>
    );
  }

  // Group plans by type
  const architecture = plans.filter((p) => p.type === 'architecture');
  const modules = plans.filter((p) => p.type === 'module');
  const executionPlans = plans.filter((p) => !p.type || p.type === 'plan');
  const hasMultipleTypes = (architecture.length > 0 || modules.length > 0) && executionPlans.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {architecture.length > 0 && (
        <Section label="Architecture">
          {architecture.map((plan) => (
            <PlanCard
              key={plan.id}
              id={plan.id}
              name={plan.name}
              body={plan.body}
              dependsOn={plan.dependsOn}
              type="architecture"
            />
          ))}
        </Section>
      )}

      {modules.length > 0 && (
        <Section label="Module Plans">
          {modules.map((plan) => {
            // Extract moduleId from __module__<id> format
            const moduleId = plan.id.replace(/^__module__/, '');
            const modStatus = moduleStatuses?.[moduleId];
            return (
              <PlanCard
                key={plan.id}
                id={plan.id}
                name={plan.name}
                body={plan.body}
                dependsOn={plan.dependsOn}
                type="module"
                moduleStatus={modStatus}
              />
            );
          })}
        </Section>
      )}

      {executionPlans.length > 0 && (
        <Section label={hasMultipleTypes ? 'Execution Plans' : undefined}>
          {executionPlans.map((plan) => (
            <PlanCard
              key={plan.id}
              id={plan.id}
              name={plan.name}
              body={plan.body}
              status={planStatuses[plan.id]}
              dependsOn={plan.dependsOn}
              filesChanged={fileChanges.get(plan.id)}
              type="plan"
              build={plan.build}
              review={plan.review}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {label && (
        <div className="text-[10px] uppercase tracking-wider text-text-dim font-medium">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}
