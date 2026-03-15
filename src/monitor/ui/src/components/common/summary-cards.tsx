import { CheckCircle2, XCircle, Loader2, Clock, Zap, DollarSign, Layers } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

interface SummaryCardsProps {
  duration: string;
  tokensIn: number;
  tokensOut: number;
  totalCost: number;
  plansCompleted: number;
  plansFailed: number;
  plansTotal: number;
  isComplete?: boolean;
  isFailed?: boolean;
}

function SummaryCard({ label, value, icon, accent }: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  accent?: 'green' | 'red' | 'blue';
}) {
  return (
    <div className={cn(
      'bg-card border rounded-lg px-4 py-3 min-w-[130px] shadow-sm shadow-black/20',
      accent === 'green' && 'border-green/30',
      accent === 'red' && 'border-red/30',
      accent === 'blue' && 'border-blue/30',
      !accent && 'border-border',
    )}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[11px] text-text-dim uppercase tracking-wide">{label}</span>
      </div>
      <div className={cn(
        'text-lg font-bold mt-1',
        accent === 'green' && 'text-green',
        accent === 'red' && 'text-red',
        accent === 'blue' && 'text-blue',
        !accent && 'text-text-bright',
      )}>
        {value}
      </div>
    </div>
  );
}

export function SummaryCards({
  duration,
  tokensIn,
  tokensOut,
  totalCost,
  plansCompleted,
  plansFailed,
  plansTotal,
  isComplete,
  isFailed,
}: SummaryCardsProps) {
  const statusAccent = isFailed ? 'red' : isComplete ? 'green' : 'blue';
  const statusIcon = isFailed
    ? <XCircle className="w-3 h-3 text-red" />
    : isComplete
      ? <CheckCircle2 className="w-3 h-3 text-green" />
      : <Loader2 className="w-3 h-3 text-blue animate-spin" />;
  const statusLabel = isFailed ? 'Failed' : isComplete ? 'Completed' : 'Running';

  return (
    <div className="flex gap-3 flex-wrap">
      <SummaryCard
        label="Status"
        value={statusLabel}
        icon={statusIcon}
        accent={statusAccent}
      />
      <SummaryCard
        label="Duration"
        value={duration}
        icon={<Clock className="w-3 h-3 text-text-dim" />}
      />
      {plansTotal > 0 && (
        <SummaryCard
          label="Plans"
          value={`${plansCompleted}/${plansTotal}${plansFailed ? ` (${plansFailed} failed)` : ''}`}
          icon={<Layers className="w-3 h-3 text-text-dim" />}
          accent={plansFailed > 0 ? 'red' : plansCompleted === plansTotal ? 'green' : undefined}
        />
      )}
      {tokensIn + tokensOut > 0 && (
        <SummaryCard
          label="Tokens"
          value={formatNumber(tokensIn + tokensOut)}
          icon={<Zap className="w-3 h-3 text-text-dim" />}
        />
      )}
      {totalCost > 0 && (
        <SummaryCard
          label="Cost"
          value={`$${totalCost.toFixed(4)}`}
          icon={<DollarSign className="w-3 h-3 text-text-dim" />}
        />
      )}
    </div>
  );
}
