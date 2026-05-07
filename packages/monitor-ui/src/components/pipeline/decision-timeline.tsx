import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SheetContent } from '@/components/ui/sheet';
import type { BuildDecision } from '@eforge-build/client/browser';

// ---------------------------------------------------------------------------
// Color families by decision kind
// ---------------------------------------------------------------------------

function getPipClass(kind: BuildDecision['kind']): string {
  switch (kind) {
    case 'review-strategy':
    case 'perspectives-inferred':
    case 'perspectives-respawned':
    case 'cycle-terminated':
      return 'bg-blue-500 border-blue-400';
    case 'evaluator-strictness':
      return 'bg-amber-500 border-amber-400';
    case 'recovery-verdict':
      return 'bg-red-500 border-red-400';
    case 'merge-conflict-resolution':
      return 'bg-purple-500 border-purple-400';
    default:
      return 'bg-gray-500 border-gray-400';
  }
}

// ---------------------------------------------------------------------------
// Tooltip summary — kind-specific key fields
// ---------------------------------------------------------------------------

function decisionSummary(decision: BuildDecision): string {
  switch (decision.kind) {
    case 'review-strategy':
      return decision.auto
        ? `${decision.strategy} — auto-threshold (${decision.auto.files} files, ${decision.auto.lines} lines)`
        : `${decision.strategy} — ${decision.source}`;
    case 'perspectives-inferred':
      return decision.perspectives.length > 0
        ? `inferred: ${decision.perspectives.join(', ')}`
        : 'inferred: none (fallback to single)';
    case 'perspectives-respawned':
      return `round ${decision.round + 1} — ${decision.perspectives.length > 0 ? decision.perspectives.join(', ') : 'auto'}`;
    case 'cycle-terminated':
      return `${decision.reason} — round ${decision.round + 1}, ${decision.issuesRemaining} issues remaining`;
    case 'evaluator-strictness':
      return `${decision.strictness} (${decision.source})`;
    case 'recovery-verdict':
      return decision.successorPrdId
        ? `${decision.verdict} → ${decision.successorPrdId}`
        : decision.verdict;
    case 'merge-conflict-resolution':
      return `${decision.strategy} — ${decision.files.length} file(s)`;
    default:
      return (decision as { kind: string }).kind;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DecisionTimelineProps {
  decisions: BuildDecision[];
}

export function DecisionTimeline({ decisions }: DecisionTimelineProps) {
  const [selectedDecision, setSelectedDecision] = useState<BuildDecision | null>(null);

  if (decisions.length === 0) return null;

  return (
    <>
      <div className="flex items-center gap-0.5 flex-wrap py-0.5">
        {decisions.map((decision, idx) => (
          <Tooltip key={idx}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={`w-2.5 h-2.5 rounded-full border cursor-pointer transition-opacity hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-offset-1 focus:ring-foreground/30 ${getPipClass(decision.kind)}`}
                onClick={() => setSelectedDecision(decision)}
                aria-label={`${decision.kind}: ${decisionSummary(decision)}`}
              />
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="font-medium text-[11px]">{decision.kind}</div>
              <div className="opacity-70 text-[10px] max-w-[200px]">{decisionSummary(decision)}</div>
              {decision.rationale && (
                <div className="opacity-50 text-[10px] max-w-[200px] mt-0.5 italic">{decision.rationale}</div>
              )}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      {selectedDecision && (
        <SheetContent
          open={selectedDecision !== null}
          onClose={() => setSelectedDecision(null)}
          title={`Decision: ${selectedDecision.kind}`}
          description={decisionSummary(selectedDecision)}
        >
          <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-bg-secondary rounded p-3 overflow-auto max-h-[60vh]">
            {JSON.stringify(selectedDecision, null, 2)}
          </pre>
        </SheetContent>
      )}
    </>
  );
}
