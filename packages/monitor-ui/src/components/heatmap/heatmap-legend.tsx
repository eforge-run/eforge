export function HeatmapLegend() {
  return (
    <div className="flex items-center gap-4 text-[10px] text-text-dim">
      <span className="uppercase tracking-wide">Risk:</span>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-sm bg-blue/25 border border-border/50" />
        <span>Single plan</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-sm bg-yellow/40 border border-border/50" />
        <span>Overlap</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-sm bg-bg-tertiary/30 border border-border/50" />
        <span>Not touched</span>
      </div>
    </div>
  );
}
