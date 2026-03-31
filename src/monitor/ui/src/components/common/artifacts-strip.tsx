import { usePlanPreview } from '@/components/preview';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface PlanArtifact {
  id: string;
  name: string;
  body: string;
}

interface ArtifactsStripProps {
  prdSource: { label: string; content: string } | null;
  plans: PlanArtifact[];
}

const pillClass =
  'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer transition-colors border-none';

const prdPillClass = `${pillClass} bg-yellow/15 text-yellow/70 hover:bg-yellow/25`;
const planPillClass = `${pillClass} bg-cyan/15 text-cyan/70 hover:bg-cyan/25`;

/** Abbreviate plan IDs like "plan-01-some-name" to "Plan 01" */
function abbreviatePlanId(id: string): string {
  const match = id.match(/^plan-(\d+)/);
  if (match) return `Plan ${match[1]}`;
  return id;
}

export function ArtifactsStrip({ prdSource, plans }: ArtifactsStripProps) {
  const { openContentPreview } = usePlanPreview();

  const hasArtifacts = prdSource !== null || plans.length > 0;

  if (!hasArtifacts) return null;

  return (
    <TooltipProvider>
      <div className="flex items-center gap-2 text-xs flex-wrap">
        {prdSource && (
          <button
            className={prdPillClass}
            onClick={() => openContentPreview(prdSource.label, prdSource.content)}
          >
            Build PRD
          </button>
        )}
        {plans.map((plan) => (
          <Tooltip key={plan.id}>
            <TooltipTrigger asChild>
              <button
                className={planPillClass}
                onClick={() => openContentPreview(plan.name || plan.id, plan.body)}
              >
                {abbreviatePlanId(plan.id)}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {plan.name || plan.id}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
