import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { profileBadgeClasses } from '@/components/layout/sidebar';
import type { OrchestrationConfig, EforgeEvent } from '@/lib/types';
import type { BuildStageSpec, ReviewProfileConfig } from '@/lib/types';

interface PlanTabProps {
  orchestration: OrchestrationConfig | null;
  pipelineEvent: (EforgeEvent & { type: 'planning:pipeline' }) | null;
}

// ---------------------------------------------------------------------------
// Stage chip strip — inline variant of BuildStageProgress for static display
// ---------------------------------------------------------------------------

function StageChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-bg-tertiary text-text-dim border border-border">
      {label}
    </span>
  );
}

function ChevronSep() {
  return <span className="text-text-dim text-[10px]">›</span>;
}

function BuildStageStrip({ stages }: { stages: BuildStageSpec[] }) {
  if (!stages || stages.length === 0) return <span className="text-text-dim text-xs">—</span>;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {stages.map((spec, i) => (
        <div key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronSep />}
          {Array.isArray(spec) ? (
            // Parallel group
            <div className="flex items-center gap-0.5 border border-border rounded px-1 py-0.5">
              {spec.map((s) => (
                <StageChip key={s} label={s} />
              ))}
            </div>
          ) : (
            <StageChip label={spec} />
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review profile display
// ---------------------------------------------------------------------------

function ReviewProfileRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="text-text-dim w-32 shrink-0">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function ReviewProfileDisplay({ review }: { review: ReviewProfileConfig }) {
  return (
    <div className="flex flex-col gap-1">
      <ReviewProfileRow label="Strategy" value={review.strategy} />
      {review.perspectives.length > 0 && (
        <ReviewProfileRow
          label="Perspectives"
          value={
            <div className="flex flex-wrap gap-1">
              {review.perspectives.map((p: string) => (
                <Badge key={p} variant="outline" className="text-[10px] px-1.5 py-0">{p}</Badge>
              ))}
            </div>
          }
        />
      )}
      <ReviewProfileRow label="Max rounds" value={String(review.maxRounds)} />
      <ReviewProfileRow label="Strictness" value={review.evaluatorStrictness} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="text-[11px] font-semibold text-text-dim uppercase tracking-wider mb-2">{title}</h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PlanTab({ orchestration, pipelineEvent }: PlanTabProps) {
  if (!orchestration && !pipelineEvent) {
    return (
      <div className="text-text-dim text-xs py-8 text-center">
        No planning data available yet...
      </div>
    );
  }

  return (
    <div className="text-sm">
      {/* Classification */}
      {(orchestration?.mode || pipelineEvent?.scope) && (
        <Section title="Classification">
          <div className="flex items-center gap-2">
            {orchestration?.mode && (
              <Badge
                variant="outline"
                className={cn(
                  'capitalize text-xs px-2 py-0.5',
                  profileBadgeClasses[orchestration.mode] ?? '',
                )}
              >
                {orchestration.mode}
              </Badge>
            )}
            {pipelineEvent?.scope && orchestration?.mode !== pipelineEvent.scope && (
              <span className="text-text-dim text-xs">{pipelineEvent.scope}</span>
            )}
            {pipelineEvent?.rationale && (
              <span className="text-text-dim text-xs">{pipelineEvent.rationale}</span>
            )}
          </div>
        </Section>
      )}

      {/* Pipeline */}
      {pipelineEvent && (
        <Section title="Pipeline">
          <div className="flex flex-col gap-3">
            {pipelineEvent.compile.length > 0 && (
              <div>
                <div className="text-xs text-text-dim mb-1">Compile stages</div>
                <div className="flex flex-wrap gap-1">
                  {pipelineEvent.compile.map((s) => (
                    <StageChip key={s} label={s} />
                  ))}
                </div>
              </div>
            )}
            {pipelineEvent.defaultBuild.length > 0 && (
              <div>
                <div className="text-xs text-text-dim mb-1">Default build</div>
                <BuildStageStrip stages={pipelineEvent.defaultBuild} />
              </div>
            )}
            <div>
              <div className="text-xs text-text-dim mb-1">Default review</div>
              <ReviewProfileDisplay review={pipelineEvent.defaultReview} />
            </div>
          </div>
        </Section>
      )}

      {/* Plans */}
      {orchestration && orchestration.plans.length > 0 && (
        <Section title="Plans">
          <div className="flex flex-col gap-3">
            {orchestration.plans.map((plan) => (
              <div
                key={plan.id}
                className="border border-border rounded-md p-3 bg-card"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <div className="text-xs font-semibold text-foreground">{plan.name}</div>
                    <div className="text-[10px] text-text-dim font-mono mt-0.5">{plan.id}</div>
                  </div>
                  <div className="text-[10px] text-text-dim font-mono shrink-0">{plan.branch}</div>
                </div>

                {plan.dependsOn && plan.dependsOn.length > 0 && (
                  <div className="mb-2 flex items-center gap-1 flex-wrap">
                    <span className="text-[10px] text-text-dim">depends on:</span>
                    {plan.dependsOn.map((dep) => (
                      <Badge key={dep} variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                        {dep}
                      </Badge>
                    ))}
                  </div>
                )}

                {plan.build && plan.build.length > 0 && (
                  <div className="mb-2">
                    <div className="text-[10px] text-text-dim mb-1">Build stages</div>
                    <BuildStageStrip stages={plan.build} />
                  </div>
                )}

                {plan.review && (
                  <div>
                    <div className="text-[10px] text-text-dim mb-1">Review</div>
                    <ReviewProfileDisplay review={plan.review} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
