import { useState, useEffect } from 'react';
import { FileText } from 'lucide-react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { Button } from '@/components/ui/button';
import { SheetContent } from '@/components/ui/sheet';
import type { ReadSidecarResponse } from '@eforge-build/client';
import { applyRecovery, triggerRecover } from '@/lib/api';

interface RecoverySidecarSheetProps {
  /** The full sidecar response (markdown + JSON). */
  sidecar: ReadSidecarResponse;
  /** PRD ID shown as the sheet subtitle. */
  prdId: string;
}

/**
 * A "view report" link that opens a shadcn-styled slide-over Sheet
 * rendering the recovery sidecar markdown plus verdict-specific action buttons.
 *
 * Uses the `plan-prose` CSS class (already defined in globals.css) for
 * consistent typography with the plan viewer.
 */
export function RecoverySidecarSheet({ sidecar, prdId }: RecoverySidecarSheetProps) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !sidecar.markdown) return;
    const marked = new Marked({ gfm: true });
    const raw = marked.parse(sidecar.markdown, { async: false }) as string;
    setHtml(DOMPurify.sanitize(raw));
  }, [open, sidecar.markdown]);

  // Reset error state when sheet opens
  useEffect(() => {
    if (open) setActionError(null);
  }, [open]);

  type VerdictShape = { verdict: 'retry' | 'split' | 'abandon' | 'manual'; confidence: string };
  const verdict = (sidecar.json.verdict as unknown as VerdictShape).verdict;
  const setName = sidecar.json.summary.setName;

  async function handleApply() {
    setIsApplying(true);
    setActionError(null);
    try {
      const result = await applyRecovery(prdId);
      if (result) {
        setOpen(false);
      } else {
        setActionError('Recovery action failed. Please try again or check the daemon logs.');
      }
    } finally {
      setIsApplying(false);
    }
  }

  async function handleRerunAnalysis() {
    setIsAnalyzing(true);
    setActionError(null);
    try {
      const result = await triggerRecover(setName, prdId);
      if (!result) {
        setActionError('Failed to start recovery analysis. Please try again or check the daemon logs.');
      }
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-[11px] text-blue inline-flex items-center gap-1"
        onClick={() => setOpen(true)}
      >
        <FileText size={10} />
        view report
      </Button>
      <SheetContent
        open={open}
        onClose={() => setOpen(false)}
        title="Recovery Report"
        description={prdId}
      >
        <div className="flex flex-col h-full">
          <div
            className="flex-1 overflow-y-auto p-4 text-xs plan-prose"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <div className="flex-shrink-0 border-t border-border px-4 py-3 flex flex-col gap-2">
            {actionError && (
              <p className="text-xs text-red-400">{actionError}</p>
            )}
            <div className="flex items-center gap-2">
              {verdict === 'retry' && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={isApplying || isAnalyzing}
                  onClick={handleApply}
                >
                  {isApplying ? 'Re-queuing…' : 'Re-queue PRD'}
                </Button>
              )}
              {verdict === 'split' && (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={isApplying || isAnalyzing}
                  onClick={handleApply}
                >
                  {isApplying ? 'Enqueuing…' : 'Enqueue successor PRD'}
                </Button>
              )}
              {verdict === 'abandon' && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={isApplying || isAnalyzing}
                  onClick={handleApply}
                >
                  {isApplying ? 'Archiving…' : 'Archive failed PRD'}
                </Button>
              )}
              {verdict === 'manual' && (
                <p className="text-xs text-text-dim italic">
                  Use /recover in chat to act on this verdict.
                </p>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={isApplying || isAnalyzing}
                onClick={handleRerunAnalysis}
              >
                {isAnalyzing ? 'Starting…' : 'Re-run analysis'}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </>
  );
}
