import { forwardRef, type ReactNode, type RefObject } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TimelineControls } from '@/components/timeline/timeline-controls';

export type LowerTab = 'log' | 'changes' | 'graph';

interface ConsolePanelProps {
  activeTab: LowerTab;
  onTabChange: (tab: LowerTab) => void;
  graphEnabled: boolean;
  showVerbose: boolean;
  onToggleVerbose: (checked: boolean) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  autoScroll: boolean;
  onEnableAutoScroll: () => void;
  children: ReactNode;
}

const TAB_ITEMS: Array<{ id: LowerTab; label: string }> = [
  { id: 'log', label: 'Log' },
  { id: 'changes', label: 'Changes' },
  { id: 'graph', label: 'Graph' },
];

export const ConsolePanel = forwardRef<HTMLDivElement, ConsolePanelProps>(
  function ConsolePanel(
    {
      activeTab,
      onTabChange,
      graphEnabled,
      showVerbose,
      onToggleVerbose,
      collapsed,
      onToggleCollapse,
      scrollRef,
      autoScroll,
      onEnableAutoScroll,
      children,
    },
    _ref,
  ) {
    return (
      <div className="flex flex-col h-full">
        {/* Tab bar header */}
        <div className="flex items-center justify-between px-2 border-b border-border bg-card shrink-0">
          <div className="flex items-center">
            {TAB_ITEMS.map(({ id, label }) => {
              const disabled = id === 'graph' && !graphEnabled;
              return (
                <button
                  key={id}
                  onClick={() => !disabled && onTabChange(id)}
                  disabled={disabled}
                  className={cn(
                    'px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors',
                    activeTab === id
                      ? 'border-primary text-foreground'
                      : disabled
                        ? 'border-transparent text-text-dim/40 cursor-default'
                        : 'border-transparent text-text-dim hover:text-foreground cursor-pointer',
                  )}
                  title={disabled ? 'Available when plans have dependency edges' : undefined}
                >
                  {label}
                </button>
              );
            })}
            {!collapsed && activeTab === 'log' && (
              <div className="ml-2">
                <TimelineControls showVerbose={showVerbose} onToggleVerbose={onToggleVerbose} />
              </div>
            )}
          </div>
          <button
            onClick={onToggleCollapse}
            className="p-1 text-text-dim hover:text-foreground transition-colors cursor-pointer"
            title={collapsed ? 'Expand panel' : 'Collapse panel'}
          >
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        {/* Panel body */}
        {!collapsed && (
          <div
            ref={activeTab === 'log' ? scrollRef : undefined}
            className={cn(
              'flex-1 min-h-0',
              activeTab === 'graph' ? 'overflow-hidden' : 'overflow-y-auto',
              activeTab !== 'graph' && 'px-4 py-2',
            )}
          >
            {children}

            {/* Auto-scroll button - log tab only */}
            {activeTab === 'log' && !autoScroll && (
              <button
                onClick={onEnableAutoScroll}
                className="sticky bottom-2 left-1/2 -translate-x-1/2 bg-bg-tertiary border border-border rounded-md px-3 py-1.5 text-[11px] text-text-dim cursor-pointer hover:text-foreground z-10"
              >
                ↓ Auto-scroll
              </button>
            )}
          </div>
        )}
      </div>
    );
  },
);
