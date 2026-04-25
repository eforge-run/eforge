import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface SheetContentProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * A slide-over panel (right-anchored) styled to match the shadcn/ui Sheet
 * primitive. Implemented without @radix-ui/react-dialog to avoid adding a
 * new dependency; the accessibility semantics (role, aria-modal) are set
 * manually.
 */
export function SheetContent({
  open,
  onClose,
  title,
  description,
  className,
  children,
}: SheetContentProps) {
  // Close on Escape key
  React.useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop overlay */}
      <div
        className="fixed inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Slide-over panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'fixed right-0 inset-y-0 w-[520px] max-w-full bg-card border-l border-border z-50 flex flex-col shadow-xl',
          className,
        )}
      >
        <div className="flex items-start justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div>
            {title && (
              <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            )}
            {description && (
              <p className="text-[11px] text-text-dim mt-0.5">{description}</p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 -mr-1 -mt-0.5"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
