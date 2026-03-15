import type { PipelineStage, ReviewIssue } from '@/lib/types';
import { PipelineRow } from './pipeline-row';

interface PipelineProps {
  planStatuses: Record<string, PipelineStage>;
  reviewIssues?: Record<string, ReviewIssue[]>;
}

export function Pipeline({ planStatuses, reviewIssues }: PipelineProps) {
  const entries = Object.entries(planStatuses);
  if (entries.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3 shadow-sm shadow-black/20">
      <h3 className="text-[11px] uppercase tracking-wider text-text-dim mb-2 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-blue" />
        Pipeline
      </h3>
      <div className="flex flex-col gap-1.5">
        {entries.map(([planId, stage]) => (
          <PipelineRow
            key={planId}
            planId={planId}
            currentStage={stage}
            reviewIssues={reviewIssues?.[planId]}
          />
        ))}
      </div>
    </div>
  );
}
