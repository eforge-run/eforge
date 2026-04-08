import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FileText, GitBranch, Loader2, CheckCircle2, Puzzle } from 'lucide-react';
import { PlanBodyHighlight } from '@/components/preview/plan-body-highlight';
import { BuildConfigSection } from '@/components/plans/build-config';
import { cn } from '@/lib/utils';
import type { BuildStageSpec, ReviewProfileConfig, PipelineStage, PlanType } from '@/lib/types';
import type { ModuleStatus } from '@/lib/reducer';

interface PlanCardProps {
  id: string;
  name: string;
  body: string;
  status?: PipelineStage;
  dependsOn?: string[];
  filesChanged?: string[];
  type?: PlanType;
  moduleStatus?: ModuleStatus;
  build?: BuildStageSpec[];
  review?: ReviewProfileConfig;
}

export function StatusBadge({ status }: { status?: PipelineStage }) {
  if (!status) return null;
  const cls: Record<string, string> = {
    plan: 'bg-yellow/15 text-yellow',
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

export function ModuleStatusBadge({ status }: { status?: ModuleStatus }) {
  if (!status) return null;
  if (status === 'planning') {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-yellow/15 text-yellow flex items-center gap-1">
        <Loader2 className="w-2.5 h-2.5 animate-spin" />
        planning
      </span>
    );
  }
  if (status === 'complete') {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-green/15 text-green flex items-center gap-1">
        <CheckCircle2 className="w-2.5 h-2.5" />
        complete
      </span>
    );
  }
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-bg-tertiary text-text-dim">
      {status}
    </span>
  );
}

function TypeIcon({ type }: { type?: PlanType; }) {
  if (type === 'architecture') return <BookOpen className="w-3.5 h-3.5 text-cyan" />;
  if (type === 'module') return <Puzzle className="w-3.5 h-3.5 text-yellow" />;
  return null;
}

export function PlanCard({ id, name, body, status, dependsOn, filesChanged, type, moduleStatus, build, review }: PlanCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const displayId = (() => {
    switch (type) {
      case 'architecture': return undefined;
      case 'module': return id.replace(/^__module__/, '');
      default: return id;
    }
  })();

  return (
    <div className="bg-card border border-border rounded-lg shadow-sm shadow-black/10 overflow-hidden">
      {/* Header — always visible */}
      <button
        className="w-full text-left flex items-start gap-2.5 px-4 py-3 cursor-pointer hover:bg-bg-tertiary transition-colors bg-transparent border-none"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="mt-0.5 flex items-center gap-1.5">
          {isExpanded
            ? <ChevronDown className="w-3.5 h-3.5 text-text-dim" />
            : <ChevronRight className="w-3.5 h-3.5 text-text-dim" />
          }
          <TypeIcon type={type} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="text-sm font-semibold text-text-bright">{name}</span>
            {type === 'module' ? <ModuleStatusBadge status={moduleStatus} /> : <StatusBadge status={status} />}
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-text-dim">
            {displayId && <span className="font-mono">{displayId}</span>}
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
          <BuildConfigSection build={build} review={review} />
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
