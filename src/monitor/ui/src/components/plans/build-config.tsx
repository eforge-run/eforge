import { ChevronRight } from 'lucide-react';
import type { BuildStageSpec, ReviewProfileConfig } from '@/lib/types';

interface BuildConfigSectionProps {
  build?: BuildStageSpec[];
  review?: ReviewProfileConfig;
}

function StagePill({ name }: { name: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap bg-bg-tertiary text-text-dim/80">
      {name}
    </span>
  );
}

function ParallelGroup({ stages }: { stages: string[] }) {
  return (
    <div className="flex flex-col gap-0.5 border border-border/50 rounded px-1 py-0.5">
      {stages.map((s, i) => (
        <StagePill key={`${s}-${i}`} name={s} />
      ))}
    </div>
  );
}

function BuildPipeline({ stages }: { stages: BuildStageSpec[] }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {stages.map((stage, i) => (
        <div key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="w-2.5 h-2.5 text-text-dim/50 flex-shrink-0" />}
          {Array.isArray(stage) ? (
            <ParallelGroup stages={stage} />
          ) : (
            <StagePill name={stage} />
          )}
        </div>
      ))}
    </div>
  );
}

function ReviewConfig({ review }: { review: ReviewProfileConfig }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-bg-tertiary text-text-dim/80">
        {review.strategy}
      </span>
      {review.perspectives.length > 0 && (
        <span className="text-[10px] text-text-dim">
          {review.perspectives.join(', ')}
        </span>
      )}
      <span className="text-[10px] text-text-dim">
        {review.maxRounds} round{review.maxRounds !== 1 ? 's' : ''}
      </span>
      <span className="text-[10px] text-text-dim">
        {review.evaluatorStrictness}
      </span>
    </div>
  );
}

export function BuildConfigSection({ build, review }: BuildConfigSectionProps) {
  if (!build && !review) return null;

  return (
    <div className="mb-3 flex flex-col gap-2">
      {build && build.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1">Build Pipeline</div>
          <BuildPipeline stages={build} />
        </div>
      )}
      {review && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1">Review Config</div>
          <ReviewConfig review={review} />
        </div>
      )}
    </div>
  );
}
