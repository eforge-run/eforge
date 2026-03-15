import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, GitBranch } from 'lucide-react';
import { PlanBodyHighlight } from '@/components/preview/plan-body-highlight';
import { cn } from '@/lib/utils';
import type { PipelineStage } from '@/lib/types';

interface PlanCardProps {
  id: string;
  name: string;
  body: string;
  status?: PipelineStage;
  dependsOn?: string[];
  filesChanged?: string[];
}

function StatusBadge({ status }: { status?: PipelineStage }) {
  if (!status) return null;
  const cls: Record<string, string> = {
    implement: 'bg-blue/15 text-blue',
    review: 'bg-yellow/15 text-yellow',
    evaluate: 'bg-purple/15 text-purple',
    complete: 'bg-green/15 text-green',
    failed: 'bg-red/15 text-red',
  };
  return (
    <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-sm', cls[status] || 'bg-bg-tertiary text-text-dim')}>
      {status}
    </span>
  );
}

export function PlanCard({ id, name, body, status, dependsOn, filesChanged }: PlanCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="bg-card border border-border rounded-lg shadow-sm shadow-black/10 overflow-hidden">
      {/* Header — always visible */}
      <button
        className="w-full text-left flex items-start gap-2.5 px-4 py-3 cursor-pointer hover:bg-bg-tertiary transition-colors bg-transparent border-none"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="mt-0.5">
          {isExpanded
            ? <ChevronDown className="w-3.5 h-3.5 text-text-dim" />
            : <ChevronRight className="w-3.5 h-3.5 text-text-dim" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="text-sm font-semibold text-text-bright">{name}</span>
            <StatusBadge status={status} />
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-text-dim">
            <span className="font-mono">{id}</span>
            {dependsOn && dependsOn.length > 0 && (
              <span className="flex items-center gap-0.5">
                <GitBranch className="w-2.5 h-2.5" />
                {dependsOn.join(', ')}
              </span>
            )}
            {filesChanged && filesChanged.length > 0 && (
              <span className="flex items-center gap-0.5">
                <FileText className="w-2.5 h-2.5" />
                {filesChanged.length} file{filesChanged.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Body — expanded */}
      {isExpanded && (
        <div className="border-t border-border px-4 py-3">
          {filesChanged && filesChanged.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1">Files Changed</div>
              <div className="flex flex-wrap gap-1">
                {filesChanged.map((f) => (
                  <span key={f} className="text-[10px] font-mono bg-bg-tertiary px-1.5 py-0.5 rounded text-text-dim">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
          <PlanBodyHighlight content={body} />
        </div>
      )}
    </div>
  );
}
