import type { PipelineStage } from '@/lib/types';
import { PipelineRow } from './pipeline-row';

interface PipelineProps {
  planStatuses: Record<string, PipelineStage>;
}

export function Pipeline({ planStatuses }: PipelineProps) {
  const entries = Object.entries(planStatuses);
  if (entries.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3">
      <h3 className="text-[11px] uppercase tracking-wide text-text-dim mb-2">
        Pipeline
      </h3>
      {entries.map(([planId, stage]) => (
        <PipelineRow key={planId} planId={planId} currentStage={stage} />
      ))}
    </div>
  );
}
