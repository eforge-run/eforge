import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchFileDiff } from '@/lib/api';
import { getHighlighter } from '@/lib/shiki';

interface DiffEntry {
  planId: string;
  diff: string | null;
  tooLarge?: boolean;
  binary?: boolean;
  error?: string;
}

interface DiffViewerProps {
  sessionId: string;
  planId: string | null;
  filePath: string;
  planIds?: string[];
  onClose: () => void;
}

export function DiffViewer({ sessionId, planId, filePath, planIds, onClose }: DiffViewerProps) {
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<DiffEntry[]>([]);
  const [highlightedHtmls, setHighlightedHtmls] = useState<Map<string, string>>(new Map());
  const [highlightFailed, setHighlightFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Stable serialization of planIds to avoid re-fetching on every render
  const planIdsKey = useMemo(() => (planIds ?? []).join(','), [planIds]);

  // Escape key handler
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Fetch diffs
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setEntries([]);
      setHighlightedHtmls(new Map());
      setHighlightFailed(false);

      try {
        let fetchedEntries: DiffEntry[];

        if (planId) {
          // Single plan+file diff
          try {
            const result = await fetchFileDiff(sessionId, planId, filePath);
            fetchedEntries = [{ planId, ...result }];
          } catch {
            fetchedEntries = [{ planId, diff: null, error: 'Commit not found' }];
          }
        } else {
          // All plans that touched this file
          const relevantPlanIds = planIds ?? [];
          fetchedEntries = [];
          for (const pid of relevantPlanIds) {
            try {
              const result = await fetchFileDiff(sessionId, pid, filePath);
              fetchedEntries.push({ planId: pid, ...result });
            } catch {
              fetchedEntries.push({ planId: pid, diff: null, error: 'Commit not found' });
            }
          }
        }

        if (cancelled) return;
        setEntries(fetchedEntries);

        // Highlight diffs with Shiki
        await highlightEntries(fetchedEntries);
      } catch {
        if (!cancelled) {
          setEntries([{ planId: planId ?? 'unknown', diff: null, error: 'Failed to fetch diff' }]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    async function highlightEntries(fetchedEntries: DiffEntry[]) {
      const diffsToHighlight = fetchedEntries.filter((e) => e.diff);
      if (diffsToHighlight.length === 0) return;

      try {
        const highlighter = await getHighlighter();
        if (cancelled) return;

        const htmlMap = new Map<string, string>();
        for (const entry of diffsToHighlight) {
          if (entry.diff) {
            const html = highlighter.codeToHtml(entry.diff, {
              lang: 'diff',
              theme: 'github-dark',
            });
            htmlMap.set(entry.planId, html);
          }
        }

        if (!cancelled) {
          setHighlightedHtmls(htmlMap);
        }
      } catch (err) {
        console.error('Failed to initialize shiki for diff:', err);
        if (!cancelled) {
          setHighlightFailed(true);
        }
      }
    }

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, planId, filePath, planIdsKey]);

  return (
    <div ref={containerRef} className="flex-1 min-w-0 bg-card border border-border rounded-lg flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="text-[11px] text-text-dim truncate mr-2" title={filePath}>
          {filePath}
          {planId && <span className="ml-2 text-text-bright">{planId}</span>}
        </div>
        <button
          onClick={onClose}
          className="text-text-dim hover:text-text-bright text-sm cursor-pointer shrink-0 px-1"
          title="Close (Escape)"
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3">
        {loading ? (
          <div className="flex items-center gap-2 text-text-dim text-xs py-4">
            <div className="w-4 h-4 border-2 border-text-dim border-t-transparent rounded-full animate-spin" />
            Loading diff...
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {entries.map((entry) => (
              <div key={entry.planId}>
                {/* Plan header divider for multi-plan view */}
                {!planId && (
                  <div className="text-[10px] uppercase tracking-wide text-text-dim mb-2 pb-1 border-b border-border/50">
                    {entry.planId}
                  </div>
                )}

                {entry.error ? (
                  <div className="text-red text-xs py-2">{entry.error}</div>
                ) : entry.binary ? (
                  <div className="text-text-dim text-xs py-2">Binary file</div>
                ) : entry.tooLarge ? (
                  <div className="text-text-dim text-xs py-2">Diff too large to display</div>
                ) : !entry.diff ? (
                  <div className="text-text-dim text-xs py-2">No changes</div>
                ) : highlightedHtmls.has(entry.planId) ? (
                  <div
                    className="text-xs overflow-x-auto [&_pre]:!bg-transparent [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_code]:text-xs"
                    dangerouslySetInnerHTML={{ __html: highlightedHtmls.get(entry.planId)! }}
                  />
                ) : (
                  <div>
                    <pre className="text-xs text-foreground whitespace-pre-wrap break-words overflow-x-auto">
                      {entry.diff}
                    </pre>
                    {highlightFailed && (
                      <div className="text-[10px] text-text-dim mt-1">Highlighting unavailable</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
