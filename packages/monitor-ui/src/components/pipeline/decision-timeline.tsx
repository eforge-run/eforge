import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SheetContent } from '@/components/ui/sheet';
import type { DecisionPoint, Decision } from '@/lib/reducer';
import { decisionKindColor, decisionSummary, decisionDetail } from '@/lib/decision-format';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DecisionTimelineProps {
  decisions: DecisionPoint[];
  sessionStart: number;
  totalSpan: number;
  label?: string;
}

export function DecisionTimeline({ decisions, sessionStart, totalSpan, label }: DecisionTimelineProps) {
  const [selectedDecision, setSelectedDecision] = useState<Decision | null>(null);

  if (decisions.length === 0) return null;

  return (
    <>
      {label && (
        <div className="text-[10px] text-text-dim mb-0.5 uppercase tracking-wider">{label}</div>
      )}
      <div className="relative h-4">
        {decisions.map((dp, idx) => {
          const decisionTime = new Date(dp.timestamp).getTime();
          const leftPercent = Math.max(0, Math.min(((decisionTime - sessionStart) / totalSpan) * 100, 100));
          const { bg, border } = decisionKindColor(dp.decision.kind);

          return (
            <Tooltip key={idx}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={`absolute top-0 bottom-0 w-1 rounded-sm border cursor-pointer transition-opacity hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-offset-1 focus:ring-foreground/30 hover:z-10 focus:z-10 ${bg} ${border}`}
                  style={{ left: `${leftPercent}%` }}
                  onClick={() => setSelectedDecision(dp.decision)}
                  aria-label={`${dp.decision.kind}: ${decisionSummary(dp.decision)}`}
                >
                  <span className="absolute -top-0.5 left-0 right-0 h-1 rounded-t-sm" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="font-medium text-[11px]">{dp.decision.kind}</div>
                <div className="opacity-70 text-[10px] max-w-[200px]">{decisionSummary(dp.decision)}</div>
                {dp.decision.rationale && (
                  <div className="opacity-50 text-[10px] max-w-[200px] mt-0.5 italic">{dp.decision.rationale}</div>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {selectedDecision && (
        <SheetContent
          open={selectedDecision !== null}
          onClose={() => setSelectedDecision(null)}
          title={`Decision: ${selectedDecision.kind}`}
          description={decisionSummary(selectedDecision)}
        >
          <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-bg-secondary rounded p-3 overflow-auto max-h-[60vh]">
            {decisionDetail(selectedDecision)}
          </pre>
        </SheetContent>
      )}
    </>
  );
}
