interface HeatmapSummaryProps {
  totalFiles: number;
  overlappingFiles: number;
}

function StatItem({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-text-dim uppercase tracking-wide">{label}</span>
      <span className={`text-sm font-bold ${highlight ? 'text-red' : 'text-text-bright'}`}>
        {value}
      </span>
    </div>
  );
}

export function HeatmapSummary({ totalFiles, overlappingFiles }: HeatmapSummaryProps) {
  return (
    <div className="flex gap-6">
      <StatItem label="Files Changed" value={totalFiles.toString()} />
      <StatItem label="Overlapping" value={overlappingFiles.toString()} highlight={overlappingFiles > 0} />
    </div>
  );
}
