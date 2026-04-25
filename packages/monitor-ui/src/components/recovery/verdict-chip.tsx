import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type RecoveryVerdictValue = 'retry' | 'split' | 'abandon' | 'manual';
export type RecoveryConfidenceValue = 'low' | 'medium' | 'high';

/**
 * Returns the Badge class string for a given recovery verdict.
 * Color mapping: retry → blue, split → yellow/amber, abandon → red, manual → gray.
 * Exported as a pure function so it can be unit-tested without DOM rendering.
 */
export function getVerdictChipClass(verdict: RecoveryVerdictValue): string {
  switch (verdict) {
    case 'retry':
      return 'border-blue/30 bg-blue/10 text-blue';
    case 'split':
      return 'border-yellow/30 bg-yellow/10 text-yellow';
    case 'abandon':
      return 'border-red/30 bg-red/10 text-red';
    case 'manual':
      return 'border-text-dim/30 bg-bg-tertiary text-text-dim';
  }
}

/**
 * Returns the Tailwind class for the confidence dot indicator.
 * Exported for unit testing.
 */
export function getConfidenceClass(confidence: RecoveryConfidenceValue): string {
  switch (confidence) {
    case 'high':
      return 'text-green';
    case 'medium':
      return 'text-yellow';
    case 'low':
      return 'text-red';
  }
}

interface RecoveryVerdictChipProps {
  verdict: RecoveryVerdictValue;
  confidence: RecoveryConfidenceValue;
  className?: string;
}

/**
 * Shadcn Badge-based chip that displays a recovery verdict with a
 * confidence dot indicator.
 *
 * Verdict colors: retry=blue, split=yellow, abandon=red, manual=gray.
 * Confidence dot: high=green, medium=yellow, low=red.
 */
export function RecoveryVerdictChip({
  verdict,
  confidence,
  className,
}: RecoveryVerdictChipProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[10px] px-1.5 py-0 rounded-sm gap-1 h-auto font-medium',
        getVerdictChipClass(verdict),
        className,
      )}
    >
      <span>{verdict}</span>
      <span className={cn('text-[8px]', getConfidenceClass(confidence))}>●</span>
      <span className="opacity-70 text-[9px]">{confidence}</span>
    </Badge>
  );
}
