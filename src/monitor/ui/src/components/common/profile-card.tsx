import type { ProfileInfo, BuildStageSpec } from '@/lib/types';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';

const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  errand: { bg: 'bg-[#3fb950]/15', text: 'text-[#3fb950]', border: 'border-[#3fb950]/30' },
  excursion: { bg: 'bg-[#58a6ff]/15', text: 'text-[#58a6ff]', border: 'border-[#58a6ff]/30' },
  expedition: { bg: 'bg-[#f0883e]/15', text: 'text-[#f0883e]', border: 'border-[#f0883e]/30' },
};

const DEFAULT_TIER = { bg: 'bg-[#bc8cff]/15', text: 'text-[#bc8cff]', border: 'border-[#bc8cff]/30' };

function getTierColor(name: string) {
  return TIER_COLORS[name] ?? DEFAULT_TIER;
}

type StageCategory = 'planning' | 'review' | 'build' | 'utility' | 'evaluation' | 'expedition';

const STAGE_CATEGORY_COLORS: Record<StageCategory, string> = {
  planning: 'bg-yellow-500/20 text-yellow-400',
  review: 'bg-green-500/20 text-green-400',
  build: 'bg-blue-500/20 text-blue-400',
  utility: 'bg-cyan-500/20 text-cyan-400',
  evaluation: 'bg-purple-500/20 text-purple-400',
  expedition: 'bg-orange-500/20 text-orange-400',
};

function categorizeStage(stage: string): StageCategory {
  if (stage === 'planner' || stage === 'prd-passthrough') return 'planning';
  if (stage === 'evaluate' || stage === 'review-fix') return 'evaluation';
  if (stage.includes('review') || stage.includes('cohesion')) return 'review';
  if (stage === 'implement') return 'build';
  if (stage === 'doc-update' || stage === 'validate') return 'utility';
  if (stage.includes('expedition') || stage.includes('module')) return 'expedition';
  return 'build';
}

function StagePill({ stage }: { stage: string }) {
  const category = categorizeStage(stage);
  const color = STAGE_CATEGORY_COLORS[category];
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${color}`}>
      {stage}
    </span>
  );
}

function Chevron() {
  return (
    <svg className="w-3 h-3 text-text-dim/40 shrink-0" viewBox="0 0 12 12" fill="none">
      <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StageFlow({ label, stages }: { label: string; stages: BuildStageSpec[] }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[10px] text-text-dim uppercase tracking-wide w-14 shrink-0 pt-0.5">{label}</span>
      <div className="flex items-center gap-1 flex-wrap">
        {stages.map((stage, i) => (
          <div key={i} className="flex items-center gap-1">
            {i > 0 && <Chevron />}
            {Array.isArray(stage) ? (
              <div className="flex flex-col gap-0.5 border-l-2 border-text-dim/20 pl-1.5">
                {stage.map((s) => (
                  <StagePill key={s} stage={s} />
                ))}
              </div>
            ) : (
              <StagePill stage={stage} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface ProfileCardProps {
  profileInfo: ProfileInfo;
}

export function ProfileCard({ profileInfo }: ProfileCardProps) {
  if (!profileInfo) return null;

  const { profileName, rationale, config } = profileInfo;
  const tier = getTierColor(profileName);
  const { review } = config;

  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3 shadow-sm shadow-black/20">
      <div className="flex items-center gap-3 mb-3">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={`px-2.5 py-1 rounded-md text-xs font-semibold border cursor-default ${tier.bg} ${tier.text} ${tier.border}`}>
                {profileName}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              {rationale}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span className="text-[11px] text-text-dim">{config.description}</span>
      </div>

      <div className="flex flex-col gap-2">
        <StageFlow label="Compile" stages={config.compile} />
        <StageFlow label="Build" stages={config.build} />
      </div>

      <div className="mt-2 pt-2 border-t border-border/50">
        <span className="text-[10px] text-text-dim">
          {[
            review.strategy,
            review.perspectives.length > 0 ? review.perspectives.join(', ') : null,
            `${review.maxRounds} round${review.maxRounds !== 1 ? 's' : ''}`,
            review.evaluatorStrictness,
          ].filter(Boolean).join(' · ')}
        </span>
      </div>
    </div>
  );
}
