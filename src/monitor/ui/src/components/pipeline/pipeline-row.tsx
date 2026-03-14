import { cn } from '@/lib/utils';
import type { PipelineStage } from '@/lib/types';

const STAGES: PipelineStage[] = ['implement', 'review', 'evaluate', 'complete'];

interface PipelineRowProps {
  planId: string;
  currentStage: PipelineStage;
}

export function PipelineRow({ planId, currentStage }: PipelineRowProps) {
  return (
    <div className="flex items-center gap-1 mb-1 text-[11px]">
      <span
        className="w-[120px] text-text-dim overflow-hidden text-ellipsis whitespace-nowrap"
        title={planId}
      >
        {planId}
      </span>
      <div className="flex gap-0.5 flex-1">
        {STAGES.map((stage) => {
          const stageIndex = STAGES.indexOf(stage);
          const currentIndex = STAGES.indexOf(currentStage);
          let cls = '';

          if (currentStage === 'failed') {
            // Plan failed — tint all stage cells red since we don't track which stage failed
            cls = 'bg-red/15 text-red';
          } else if (stage === currentStage) {
            cls = currentStage === 'complete' ? 'bg-green/15 text-green' : 'bg-blue/20 text-blue';
          } else if (stageIndex < currentIndex) {
            cls = 'bg-green/15 text-green';
          }

          return (
            <div
              key={stage}
              className={cn(
                'px-2 py-0.5 rounded-sm bg-bg-tertiary text-text-dim text-[10px] text-center flex-1',
                cls,
              )}
            >
              {stage}
            </div>
          );
        })}
      </div>
    </div>
  );
}
