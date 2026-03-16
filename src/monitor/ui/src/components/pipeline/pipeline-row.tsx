import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { usePlanPreview } from '@/components/preview';
import type { PipelineStage } from '@/lib/types';

const STAGES: PipelineStage[] = ['plan', 'implement', 'review', 'evaluate', 'complete'];

const STAGE_COLORS: Record<string, { bg: string; text: string; glow: string }> = {
  plan: { bg: 'bg-yellow/20', text: 'text-yellow', glow: 'rgba(227,179,65,0.4)' },
  implement: { bg: 'bg-blue/20', text: 'text-blue', glow: 'rgba(88,166,255,0.4)' },
  review: { bg: 'bg-purple/20', text: 'text-purple', glow: 'rgba(188,140,255,0.4)' },
  evaluate: { bg: 'bg-cyan/20', text: 'text-cyan', glow: 'rgba(57,210,192,0.4)' },
};

interface PipelineRowProps {
  planId: string;
  currentStage: PipelineStage;
}

export function PipelineRow({ planId, currentStage }: PipelineRowProps) {
  const { openPreview } = usePlanPreview();
  const prevStageRef = useRef<PipelineStage>(currentStage);
  const [poppingStage, setPoppingStage] = useState<PipelineStage | null>(null);

  // Detect stage advancement and trigger completion pop on the previous stage
  useEffect(() => {
    const prevStage = prevStageRef.current;
    if (prevStage !== currentStage && prevStage !== 'complete' && prevStage !== 'failed') {
      const currentIndex = STAGES.indexOf(currentStage);
      const prevIndex = STAGES.indexOf(prevStage);
      if (currentIndex > prevIndex) {
        setPoppingStage(prevStage);
        const timer = setTimeout(() => setPoppingStage(null), 400);
        prevStageRef.current = currentStage;
        return () => clearTimeout(timer);
      }
    }
    prevStageRef.current = currentStage;
  }, [currentStage]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <span
          className="w-[140px] text-text-dim overflow-hidden text-ellipsis whitespace-nowrap cursor-pointer hover:text-foreground hover:underline font-mono text-[11px]"
          title={planId}
          onClick={() => openPreview(planId)}
        >
          {planId}
        </span>
        <div className="flex gap-0 flex-1 items-center">
          {STAGES.map((stage, i) => {
            const stageIndex = STAGES.indexOf(stage);
            const currentIndex = STAGES.indexOf(currentStage);
            const isActive = stage === currentStage && currentStage !== 'complete' && currentStage !== 'failed';
            const isCompleted = currentStage === 'failed' ? false : stageIndex < currentIndex || currentStage === 'complete';
            const isFailed = currentStage === 'failed';
            const isPopping = poppingStage === stage;
            const stageColor = STAGE_COLORS[stage];

            let cls = '';
            let style: React.CSSProperties = {};

            if (isFailed) {
              cls = 'bg-red/15 text-red';
            } else if (isActive && stageColor) {
              cls = `${stageColor.bg} ${stageColor.text}`;
              style = {
                '--stage-glow-color': stageColor.glow,
                animation: 'stage-pulse 2s ease-in-out infinite, stage-shimmer 2.5s ease-in-out infinite',
                backgroundImage: `linear-gradient(90deg, transparent 30%, rgba(255,255,255,0.06) 50%, transparent 70%)`,
                backgroundSize: '200% 100%',
              } as React.CSSProperties;
            } else if (isCompleted) {
              cls = 'bg-green/15 text-green';
            }

            // Connector between pills
            const showConnector = i > 0;
            const prevCompleted = currentStage === 'failed' ? false : STAGES.indexOf(STAGES[i - 1]) < currentIndex || currentStage === 'complete';
            const nextIsActive = isActive;

            return (
              <div key={stage} className="flex items-center flex-1">
                {showConnector && (
                  <div
                    className={cn(
                      'w-[2px] h-3 transition-colors duration-300',
                      prevCompleted && nextIsActive && stageColor ? stageColor.bg : 'bg-border',
                    )}
                  />
                )}
                <div
                  className={cn(
                    'px-2 py-0.5 rounded-sm bg-bg-tertiary text-text-dim text-[10px] text-center flex-1',
                    cls,
                  )}
                  style={{
                    ...style,
                    ...(isPopping ? { animation: 'stage-complete-pop 400ms ease-out' } : {}),
                  }}
                >
                  {stage}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
