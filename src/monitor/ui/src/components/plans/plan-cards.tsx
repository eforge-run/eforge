import { useApi } from '@/hooks/use-api';
import { PlanCard } from './plan-card';
import type { PipelineStage } from '@/lib/types';

interface PlanData {
  id: string;
  name: string;
  body: string;
  dependsOn?: string[];
}

interface PlanCardsProps {
  runId: string | null;
  planStatuses: Record<string, PipelineStage>;
  fileChanges: Map<string, string[]>;
}

export function PlanCards({ runId, planStatuses, fileChanges }: PlanCardsProps) {
  const { data: plans, loading, error } = useApi<PlanData[]>(
    runId ? `/api/plans/${runId}` : null,
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

  return (
    <div className="flex flex-col gap-3">
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          id={plan.id}
          name={plan.name}
          body={plan.body}
          status={planStatuses[plan.id]}
          dependsOn={plan.dependsOn}
          filesChanged={fileChanges.get(plan.id)}
        />
      ))}
    </div>
  );
}
