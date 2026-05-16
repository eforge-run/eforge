import type { Decision } from '@/lib/reducer';

type CycleTerminatedDecision = Extract<Decision, { kind: 'cycle-terminated' }>;
type EnrichedCycleTerminatedDecision = CycleTerminatedDecision & {
  lastReviewIssueCount?: number;
  finalEvaluationRan?: boolean;
  finalEvaluationAccepted?: number;
  finalEvaluationRejected?: number;
};

function enrichedCycleTerminated(decision: CycleTerminatedDecision): EnrichedCycleTerminatedDecision {
  return decision as EnrichedCycleTerminatedDecision;
}

// ---------------------------------------------------------------------------
// Color families by decision kind
// ---------------------------------------------------------------------------

export function decisionKindColor(kind: Decision['kind']): { bg: string; border: string } {
  switch (kind) {
    // Planning-phase kinds — teal/green family
    case 'scope-selected':
      return { bg: 'bg-teal-500', border: 'border-teal-400' };
    case 'build-pipeline-chosen':
      return { bg: 'bg-green-500', border: 'border-green-400' };
    case 'review-profile-chosen':
      return { bg: 'bg-emerald-500', border: 'border-emerald-400' };
    case 'plan-set-shape':
      return { bg: 'bg-cyan-500', border: 'border-cyan-400' };
    // Build-phase kinds — blue/amber/red/purple family
    case 'review-strategy':
    case 'perspectives-inferred':
    case 'perspectives-respawned':
    case 'cycle-terminated':
      return { bg: 'bg-blue-500', border: 'border-blue-400' };
    case 'evaluator-strictness':
      return { bg: 'bg-amber-500', border: 'border-amber-400' };
    case 'recovery-verdict':
      return { bg: 'bg-red-500', border: 'border-red-400' };
    case 'merge-conflict-resolution':
      return { bg: 'bg-purple-500', border: 'border-purple-400' };
    default:
      return { bg: 'bg-gray-500', border: 'border-gray-400' };
  }
}

// ---------------------------------------------------------------------------
// Tooltip summary — kind-specific key fields
// ---------------------------------------------------------------------------

export function decisionSummary(decision: Decision): string {
  switch (decision.kind) {
    // Planning-phase summaries
    case 'scope-selected':
      return `${decision.scope} (via ${decision.source})`;
    case 'build-pipeline-chosen':
      return `${decision.defaultBuild.length} stage(s)`;
    case 'review-profile-chosen':
      return `${decision.strategy} — ${decision.perspectives.join(', ')} — ${decision.maxRounds} round(s)`;
    case 'plan-set-shape':
      return `${decision.planCount} plan(s): ${decision.planIds.join(', ')}`;
    // Build-phase summaries
    case 'review-strategy':
      return decision.auto
        ? `${decision.strategy} — auto-threshold (${decision.auto.files} files, ${decision.auto.lines} lines)`
        : `${decision.strategy} — ${decision.source}`;
    case 'perspectives-inferred':
      return decision.perspectives.length > 0
        ? `inferred: ${decision.perspectives.join(', ')}`
        : 'inferred: none (fallback to single)';
    case 'perspectives-respawned': {
      const active = decision.perspectives.length > 0 ? decision.perspectives.join(', ') : 'auto';
      const dropped = decision.dropped.length > 0 ? `; dropped: ${decision.dropped.join(', ')}` : '';
      return `round ${decision.round + 1} — ${active}${dropped}`;
    }
    case 'cycle-terminated': {
      const enriched = enrichedCycleTerminated(decision);
      if (enriched.lastReviewIssueCount !== undefined) {
        const final = enriched.finalEvaluationRan
          ? `final evaluation: ${enriched.finalEvaluationAccepted ?? 0} accepted / ${enriched.finalEvaluationRejected ?? 0} rejected`
          : 'final evaluation: not run';
        return `${enriched.reason} — round ${enriched.round + 1}, last review: ${enriched.lastReviewIssueCount} issue(s), ${final}`;
      }
      return `${decision.reason} — round ${decision.round + 1}, ${decision.issuesRemaining} issues remaining`;
    }
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
// Detail view — rationale + kind-specific structured fields
// ---------------------------------------------------------------------------

export function decisionDetail(decision: Decision): string {
  const lines: string[] = [];
  if (decision.rationale) {
    lines.push(`Rationale: ${decision.rationale}`);
    lines.push('');
  }
  switch (decision.kind) {
    case 'scope-selected':
      lines.push(`Scope: ${decision.scope}`);
      lines.push(`Source: ${decision.source}`);
      break;
    case 'build-pipeline-chosen':
      lines.push(`Stages (${decision.defaultBuild.length}): ${decision.defaultBuild.join(', ')}`);
      break;
    case 'review-profile-chosen':
      lines.push(`Strategy: ${decision.strategy}`);
      lines.push(`Perspectives: ${decision.perspectives.join(', ')}`);
      lines.push(`Max rounds: ${decision.maxRounds}`);
      break;
    case 'plan-set-shape':
      lines.push(`Plan count: ${decision.planCount}`);
      lines.push(`Plan IDs: ${decision.planIds.join(', ')}`);
      break;
    case 'review-strategy':
      lines.push(`Strategy: ${decision.strategy}`);
      lines.push(`Source: ${decision.source}`);
      if (decision.auto) {
        lines.push(`Auto threshold: ${decision.auto.files} files, ${decision.auto.lines} lines`);
      }
      break;
    case 'perspectives-inferred':
      lines.push(`Perspectives: ${decision.perspectives.length > 0 ? decision.perspectives.join(', ') : '(none — falling back to single)'}`);
      break;
    case 'perspectives-respawned':
      lines.push(`Round: ${decision.round + 1}`);
      lines.push(`Perspectives: ${decision.perspectives.length > 0 ? decision.perspectives.join(', ') : '(auto)'}`);
      lines.push(`Dropped: ${decision.dropped.length > 0 ? decision.dropped.join(', ') : '(none)'}`);
      break;
    case 'cycle-terminated': {
      const enriched = enrichedCycleTerminated(decision);
      lines.push(`Reason: ${decision.reason}`);
      lines.push(`Round: ${decision.round + 1}`);
      if (enriched.lastReviewIssueCount !== undefined) {
        lines.push(`Last review issue count: ${enriched.lastReviewIssueCount}`);
        lines.push(`Final evaluation ran: ${enriched.finalEvaluationRan ? 'yes' : 'no'}`);
        if (enriched.finalEvaluationRan) {
          lines.push(`Final evaluation accepted: ${enriched.finalEvaluationAccepted ?? 0}`);
          lines.push(`Final evaluation rejected: ${enriched.finalEvaluationRejected ?? 0}`);
        }
        lines.push(`Post-evaluation issue count: ${decision.issuesRemaining}`);
      } else {
        lines.push(`Issues remaining: ${decision.issuesRemaining}`);
      }
      break;
    }
    case 'evaluator-strictness':
      lines.push(`Strictness: ${decision.strictness}`);
      lines.push(`Source: ${decision.source}`);
      break;
    case 'recovery-verdict':
      lines.push(`Verdict: ${decision.verdict}`);
      if (decision.successorPrdId) lines.push(`Successor PRD: ${decision.successorPrdId}`);
      break;
    case 'merge-conflict-resolution':
      lines.push(`Strategy: ${decision.strategy}`);
      lines.push(`Files (${decision.files.length}): ${decision.files.join(', ')}`);
      break;
    default:
      return JSON.stringify(decision, null, 2);
  }
  return lines.join('\n');
}
