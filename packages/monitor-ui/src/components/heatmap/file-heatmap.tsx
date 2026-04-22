import { useState, useEffect, useCallback, useMemo } from 'react';
import type { RunState } from '@/lib/reducer';
import { useHeatmapData } from './use-heatmap-data';
import { HeatmapCell } from './heatmap-cell';
import { HeatmapLegend } from './heatmap-legend';
import { HeatmapSummary } from './heatmap-summary';
import { DiffViewer } from './diff-viewer';
import { shortenPath } from '@/lib/format';
import { Button } from '@/components/ui/button';

const DEFAULT_FILE_LIMIT = 50;

interface SelectedFile {
  path: string;
  planId: string | null; // null = file-name click showing all plans
}

interface FileHeatmapProps {
  runState: RunState;
  sessionId: string | null;
}

export function FileHeatmap({ runState, sessionId }: FileHeatmapProps) {
  const { files, plans, matrix, stats } = useHeatmapData(runState);
  const [showAll, setShowAll] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);

  // Escape key to close diff panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedFile(null);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleCellClick = useCallback((filePath: string, planId: string) => {
    setSelectedFile((prev) => {
      // Toggle off if same cell
      if (prev && prev.path === filePath && prev.planId === planId) return null;
      return { path: filePath, planId };
    });
  }, []);

  const handleFileNameClick = useCallback((filePath: string) => {
    setSelectedFile((prev) => {
      // Toggle off if same file-name click
      if (prev && prev.path === filePath && prev.planId === null) return null;
      return { path: filePath, planId: null };
    });
  }, []);

  const handleCloseViewer = useCallback(() => {
    setSelectedFile(null);
  }, []);

  // Compute which plan IDs touched the selected file (for file-name click mode)
  const selectedFilePlanIds = useMemo(() => {
    if (!selectedFile) return [];
    const planRisks = matrix.get(selectedFile.path);
    if (!planRisks) return [];
    return plans
      .filter((p) => {
        const risk = planRisks.get(p.id);
        return risk && risk !== 'none';
      })
      .map((p) => p.id);
  }, [selectedFile, matrix, plans]);

  if (stats.totalFiles === 0) {
    return (
      <div className="bg-card border border-border rounded-lg px-4 py-6 text-center text-text-dim text-sm">
        Waiting for file change data...
      </div>
    );
  }

  const visibleFiles = showAll ? files : files.slice(0, DEFAULT_FILE_LIMIT);
  const hasMore = files.length > DEFAULT_FILE_LIMIT;

  return (
    <div className="flex gap-3 h-full">
      {/* Heatmap grid */}
      <div className={`bg-card border border-border rounded-lg px-4 py-3 flex flex-col gap-3 ${selectedFile ? 'min-w-[400px]' : 'flex-1'}`}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] uppercase tracking-wide text-text-dim">
            File Heatmap
          </h3>
          <HeatmapSummary {...stats} />
        </div>

        <HeatmapLegend />

        {/* Grid */}
        <div className="overflow-x-auto">
          {/* Plan column headers */}
          <div className="flex gap-0.5 mb-1" style={{ paddingLeft: '322px' }}>
            {plans.map((plan) => (
              <div
                key={plan.id}
                className="w-6 text-[9px] text-text-dim text-center overflow-hidden"
                title={plan.id}
              >
                <div className="truncate" style={{ writingMode: 'vertical-lr', height: '60px', transform: 'rotate(180deg)' }}>
                  {plan.id}
                </div>
              </div>
            ))}
          </div>

          {/* File rows */}
          {visibleFiles.map((file) => {
            const planRisks = matrix.get(file.path);
            const isFileSelected = selectedFile?.path === file.path;
            return (
              <div key={file.path} className="flex items-center gap-0.5 mb-0.5">
                <div
                  className={`w-[320px] text-[10px] overflow-hidden text-ellipsis whitespace-nowrap shrink-0 cursor-pointer hover:text-text-bright ${isFileSelected ? 'text-text-bright font-medium' : 'text-text-dim'}`}
                  title={file.path}
                  onClick={() => handleFileNameClick(file.path)}
                >
                  {shortenPath(file.path)}
                </div>
                {plans.map((plan) => {
                  const risk = planRisks?.get(plan.id) ?? 'none';
                  const isSelected = selectedFile?.path === file.path &&
                    (selectedFile?.planId === plan.id || selectedFile?.planId === null);
                  return (
                    <HeatmapCell
                      key={plan.id}
                      touched={risk !== 'none'}
                      riskLevel={risk}
                      filePath={file.path}
                      planName={plan.id}
                      onClick={() => handleCellClick(file.path, plan.id)}
                      isSelected={isSelected}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Show all toggle */}
        {hasMore && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowAll(!showAll)}
            className="self-start"
          >
            {showAll
              ? `Show top ${DEFAULT_FILE_LIMIT} files`
              : `Show all ${files.length} files (${files.length - DEFAULT_FILE_LIMIT} more)`}
          </Button>
        )}
      </div>

      {/* Diff panel */}
      {selectedFile && sessionId && (
        <DiffViewer
          sessionId={sessionId}
          planId={selectedFile.planId}
          filePath={selectedFile.path}
          planIds={selectedFilePlanIds}
          onClose={handleCloseViewer}
        />
      )}
    </div>
  );
}
