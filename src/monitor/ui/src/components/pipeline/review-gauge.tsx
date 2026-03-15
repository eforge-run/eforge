import type { ReviewIssue } from '@/lib/types';

interface ReviewGaugeProps {
  issues: ReviewIssue[];
}

export function ReviewGauge({ issues }: ReviewGaugeProps) {
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const warning = issues.filter((i) => i.severity === 'warning').length;
  const suggestion = issues.filter((i) => i.severity === 'suggestion').length;
  const total = issues.length;

  if (total === 0) return null;

  const criticalPct = (critical / total) * 100;
  const warningPct = (warning / total) * 100;
  const suggestionPct = (suggestion / total) * 100;

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden flex">
        {critical > 0 && (
          <div
            className="h-full bg-red"
            style={{ width: `${criticalPct}%` }}
          />
        )}
        {warning > 0 && (
          <div
            className="h-full bg-yellow"
            style={{ width: `${warningPct}%` }}
          />
        )}
        {suggestion > 0 && (
          <div
            className="h-full bg-text-dim/40"
            style={{ width: `${suggestionPct}%` }}
          />
        )}
      </div>
      <div className="flex items-center gap-1.5 text-[10px]">
        {critical > 0 && (
          <span className="text-red font-medium">{critical}</span>
        )}
        {warning > 0 && (
          <span className="text-yellow font-medium">{warning}</span>
        )}
        {suggestion > 0 && (
          <span className="text-text-dim font-medium">{suggestion}</span>
        )}
      </div>
    </div>
  );
}
