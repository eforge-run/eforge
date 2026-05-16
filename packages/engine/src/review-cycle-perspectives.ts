import type { ReviewIssue } from './events.js';
import {
  categorizeFiles,
  determineApplicableReviewsWithRules,
  type ReviewPerspective,
} from './review-heuristics.js';

export interface ReviewCycleEvaluationFileSummary {
  file: string;
  mode: 'file' | 'hunks';
  action?: 'accept' | 'reject' | 'review';
  acceptedHunks: number[];
  rejectedHunks: number[];
  reviewHunks: number[];
}

export interface ReviewCycleEvaluationSummary {
  ran: boolean;
  accepted: number;
  rejected: number;
  review: number;
  files: ReviewCycleEvaluationFileSummary[];
}

export interface SelectNextReviewPerspectivesInput {
  initialOrder: ReviewPerspective[];
  previousActive: ReviewPerspective[];
  issuesByPerspective?: Partial<Record<ReviewPerspective, ReviewIssue[]>>;
  evaluation?: ReviewCycleEvaluationSummary;
  previousReviewWasParallel: boolean;
  perspectiveErrors?: ReviewPerspective[];
}

export interface SelectNextReviewPerspectivesResult {
  perspectives: ReviewPerspective[];
  dropped: ReviewPerspective[];
  rationale: string;
  fallback: boolean;
}

function uniqueOrdered(perspectives: ReviewPerspective[]): ReviewPerspective[] {
  const seen = new Set<ReviewPerspective>();
  const ordered: ReviewPerspective[] = [];
  for (const perspective of perspectives) {
    if (seen.has(perspective)) continue;
    seen.add(perspective);
    ordered.push(perspective);
  }
  return ordered;
}

function stableActiveOrder(initialOrder: ReviewPerspective[], previousActive: ReviewPerspective[]): ReviewPerspective[] {
  const active = new Set(previousActive);
  const baseOrder = initialOrder.length > 0 ? initialOrder : previousActive;
  const ordered = uniqueOrdered(baseOrder).filter(perspective => active.has(perspective));
  for (const perspective of previousActive) {
    if (!ordered.includes(perspective)) ordered.push(perspective);
  }
  return ordered;
}

function fallback(previousActive: ReviewPerspective[], rationale: string): SelectNextReviewPerspectivesResult {
  return {
    perspectives: [...previousActive],
    dropped: [],
    rationale: `Fallback: ${rationale}; retained ${previousActive.length} perspective(s), dropped 0.`,
    fallback: true,
  };
}

function hasCompletionForEveryActive(input: SelectNextReviewPerspectivesInput): boolean {
  if (!input.issuesByPerspective) return false;
  return input.previousActive.every(perspective =>
    Object.prototype.hasOwnProperty.call(input.issuesByPerspective, perspective),
  );
}

function hasAnyVerdict(summary: ReviewCycleEvaluationFileSummary): boolean {
  if (summary.mode === 'file') return summary.action !== undefined;
  return summary.acceptedHunks.length > 0 || summary.rejectedHunks.length > 0 || summary.reviewHunks.length > 0;
}

function hasAcceptedVerdict(summary: ReviewCycleEvaluationFileSummary): boolean {
  if (summary.mode === 'file') return summary.action === 'accept';
  return summary.acceptedHunks.length > 0;
}

function hasPriorIssues(
  perspective: ReviewPerspective,
  issuesByPerspective: Partial<Record<ReviewPerspective, ReviewIssue[]>>,
): boolean {
  return (issuesByPerspective[perspective]?.length ?? 0) > 0;
}

function isDocsPath(file: string): boolean {
  const categories = categorizeFiles([file]);
  return categories.docs.length > 0;
}

function verifyShouldRemain(evaluation: ReviewCycleEvaluationSummary): boolean {
  const acceptedFiles = evaluation.files
    .filter(hasAcceptedVerdict)
    .map(summary => summary.file);
  if (acceptedFiles.length === 0) return false;
  return acceptedFiles.some(file => !isDocsPath(file));
}

function concernPerspectives(evaluation: ReviewCycleEvaluationSummary): Set<ReviewPerspective> {
  const relevantFiles = evaluation.files
    .filter(hasAnyVerdict)
    .map(summary => summary.file);
  const categories = categorizeFiles(relevantFiles);
  return new Set(determineApplicableReviewsWithRules(categories).perspectives);
}

export function selectNextReviewPerspectives(
  input: SelectNextReviewPerspectivesInput,
): SelectNextReviewPerspectivesResult {
  const previousActive = uniqueOrdered(input.previousActive);

  if (!input.previousReviewWasParallel) {
    return fallback(previousActive, 'previous review was not parallel');
  }

  if ((input.perspectiveErrors ?? []).length > 0) {
    return fallback(previousActive, 'one or more perspectives errored');
  }

  if (!hasCompletionForEveryActive(input)) {
    return fallback(previousActive, 'completion data was missing for one or more active perspectives');
  }

  if (!input.evaluation) {
    return fallback(previousActive, 'evaluation summary data was missing');
  }

  if (!input.evaluation.ran) {
    return fallback(previousActive, 'evaluation did not run, so evaluator file verdict data was unavailable');
  }

  const verdictCount = input.evaluation.accepted + input.evaluation.rejected + input.evaluation.review;
  if (verdictCount > 0 && input.evaluation.files.length === 0) {
    return fallback(previousActive, 'evaluation verdict counts were present but file verdict summaries were missing');
  }

  const issuesByPerspective = input.issuesByPerspective ?? {};
  const stableOrder = stableActiveOrder(input.initialOrder, previousActive);
  const overlappingConcerns = concernPerspectives(input.evaluation);
  const keepVerifyForAcceptedChanges = verifyShouldRemain(input.evaluation);

  const perspectives: ReviewPerspective[] = [];
  const dropped: ReviewPerspective[] = [];

  for (const perspective of stableOrder) {
    const keepForIssues = hasPriorIssues(perspective, issuesByPerspective);
    const keepForConcern = overlappingConcerns.has(perspective);
    const keepForVerify = perspective === 'verify' && (keepForIssues || keepVerifyForAcceptedChanges);

    if (keepForIssues || keepForConcern || keepForVerify) {
      perspectives.push(perspective);
    } else {
      dropped.push(perspective);
    }
  }

  return {
    perspectives,
    dropped,
    rationale: `Retained ${perspectives.length} perspective(s) and dropped ${dropped.length} after prior issues and evaluator file verdicts.`,
    fallback: false,
  };
}

export type { ReviewPerspective };
