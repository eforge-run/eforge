import { cn } from '@/lib/utils';
import { usePlanPreview } from '@/components/preview';
import type { PipelineStage } from '@/lib/types';

const STAGES: PipelineStage[] = ['implement', 'review', 'evaluate', 'complete'];

interface PipelineRowProps {
  planId: string;
  currentStage: PipelineStage;
}

export function PipelineRow({ planId, currentStage }: PipelineRowProps) {
  const { openPreview } = usePlanPreview();

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className="w-[140px] text-text-dim overflow-hidden text-ellipsis whitespace-nowrap cursor-pointer hover:text-foreground hover:underline font-mono text-[11px]"
        title={planId}
        onClick={() => openPreview(planId)}
      >
        {planId}
      </span>
      <div className="flex gap-1 flex-1">
        {STAGES.map((stage) => {
          const stageIndex = STAGES.indexOf(stage);
          const currentIndex = STAGES.indexOf(currentStage);
          let cls = '';

          if (currentStage === 'failed') {
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
