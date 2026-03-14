import { formatNumber } from '@/lib/format';

interface SummaryCardsProps {
  duration: string;
  eventCount: number;
  tokensIn: number;
  tokensOut: number;
  totalCost: number;
  plansCompleted: number;
  plansFailed: number;
  plansTotal: number;
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3 min-w-[140px]">
      <div className="text-[11px] text-text-dim uppercase tracking-wide">{label}</div>
      <div className="text-lg font-bold text-text-bright mt-0.5">{value}</div>
    </div>
  );
}

export function SummaryCards({
  duration,
  eventCount,
  tokensIn,
  tokensOut,
  totalCost,
  plansCompleted,
  plansFailed,
  plansTotal,
}: SummaryCardsProps) {
  return (
    <div className="flex gap-3 flex-wrap">
      <SummaryCard label="Duration" value={duration} />
      <SummaryCard label="Events" value={eventCount.toString()} />
      {tokensIn + tokensOut > 0 && (
        <SummaryCard label="Tokens" value={formatNumber(tokensIn + tokensOut)} />
      )}
      {totalCost > 0 && (
        <SummaryCard label="Cost" value={`$${totalCost.toFixed(4)}`} />
      )}
      {plansTotal > 0 && (
        <SummaryCard
          label="Plans"
          value={`${plansCompleted}/${plansTotal}${plansFailed ? ` (${plansFailed} failed)` : ''}`}
        />
      )}
    </div>
  );
}
