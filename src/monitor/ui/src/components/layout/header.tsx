import type { ConnectionStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

interface HeaderProps {
  connectionStatus: ConnectionStatus;
}

export function Header({ connectionStatus }: HeaderProps) {
  return (
    <header className="col-span-full bg-card border-b border-border px-4 py-2.5 flex items-center gap-3">
      <h1 className="text-sm font-semibold text-text-bright">eforge monitor</h1>
      <div className="ml-auto text-[11px] flex items-center gap-1.5">
        <div
          className={cn(
            'w-2 h-2 rounded-full',
            connectionStatus === 'connected' && 'bg-green',
            connectionStatus === 'connecting' && 'bg-yellow animate-[pulse-opacity_1.5s_ease-in-out_infinite]',
            connectionStatus === 'disconnected' && 'bg-text-dim',
          )}
        />
        <span className="text-text-dim">{connectionStatus}</span>
      </div>
    </header>
  );
}
