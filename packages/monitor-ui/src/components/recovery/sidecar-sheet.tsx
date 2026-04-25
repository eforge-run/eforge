import { useState, useEffect } from 'react';
import { FileText } from 'lucide-react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { Button } from '@/components/ui/button';
import { SheetContent } from '@/components/ui/sheet';
import type { ReadSidecarResponse } from '@eforge-build/client';

interface RecoverySidecarSheetProps {
  /** The full sidecar response (markdown + JSON). */
  sidecar: ReadSidecarResponse;
  /** PRD ID shown as the sheet subtitle. */
  prdId: string;
}

/**
 * A "view report" link that opens a shadcn-styled slide-over Sheet
 * rendering the recovery sidecar markdown.
 *
 * Uses the `plan-prose` CSS class (already defined in globals.css) for
 * consistent typography with the plan viewer.
 */
export function RecoverySidecarSheet({ sidecar, prdId }: RecoverySidecarSheetProps) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState('');

  useEffect(() => {
    if (!open || !sidecar.markdown) return;
    const marked = new Marked({ gfm: true });
    const raw = marked.parse(sidecar.markdown, { async: false }) as string;
    setHtml(DOMPurify.sanitize(raw));
  }, [open, sidecar.markdown]);

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
        <div
          className="p-4 text-xs plan-prose"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </SheetContent>
    </>
  );
}
