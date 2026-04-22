import { useState } from 'react';
import { XCircle, ChevronDown } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';

interface BuildFailure {
  planId: string;
  error: string;
}

interface FailureBannerProps {
  failures: BuildFailure[];
  phaseSummary: string | null;
}

/** Abbreviate plan IDs like "plan-01-some-name" to "Plan 01" */
function abbreviatePlanId(id: string): string {
  const match = id.match(/^plan-(\d+)/);
  if (match) return `Plan ${match[1]}`;
  return id;
}

const VISIBLE_THRESHOLD = 3;
const COLLAPSE_THRESHOLD = 5;

function FailureRow({ failure }: { failure: BuildFailure }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded bg-red/15 text-red font-mono text-[11px]">
        {abbreviatePlanId(failure.planId)}
      </span>
      <span className="text-text-bright">{failure.error}</span>
    </div>
  );
}

export function FailureBanner({ failures, phaseSummary }: FailureBannerProps) {
  const [open, setOpen] = useState(false);

  if (failures.length === 0) return null;

  const needsCollapsible = failures.length >= COLLAPSE_THRESHOLD;
  const visibleFailures = needsCollapsible ? failures.slice(0, VISIBLE_THRESHOLD) : failures;
  const hiddenFailures = needsCollapsible ? failures.slice(VISIBLE_THRESHOLD) : [];

  return (
    <div className="bg-red/10 border border-red/25 rounded-lg px-4 py-3 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <XCircle className="w-4 h-4 text-red shrink-0" />
        <span className="text-sm font-medium text-red">
          {failures.length === 1 ? '1 plan failed' : `${failures.length} plans failed`}
        </span>
        {phaseSummary && (
          <span className="text-xs text-text-dim ml-1">{phaseSummary}</span>
        )}
      </div>

      {/* Failure rows */}
      <div className="flex flex-col gap-1.5 pl-6">
        {visibleFailures.map((f) => (
          <FailureRow key={f.planId} failure={f} />
        ))}

        {needsCollapsible && (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleContent>
              <div className="flex flex-col gap-1.5">
                {hiddenFailures.map((f) => (
                  <FailureRow key={f.planId} failure={f} />
                ))}
              </div>
            </CollapsibleContent>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="mt-1 self-start">
                <ChevronDown
                  className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`}
                />
                {open ? 'Show less' : `Show ${hiddenFailures.length} more`}
              </Button>
            </CollapsibleTrigger>
          </Collapsible>
        )}
      </div>
    </div>
  );
}
