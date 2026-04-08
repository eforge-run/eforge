import { PanelLeftClose, PanelLeft } from 'lucide-react';
import type { AutoBuildState } from '@/lib/api';
import type { ConnectionStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';

export interface ProjectContext {
  cwd: string | null;
  gitRemote: string | null;
}

interface HeaderProps {
  connectionStatus: ConnectionStatus;
  autoBuildState: AutoBuildState | null;
  autoBuildToggling: boolean;
  onToggleAutoBuild: () => void;
  projectContext?: ProjectContext | null;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

function extractOwnerRepo(gitRemote: string): string | null {
  const match = gitRemote.match(/(?:github\.com[:/])([^/]+\/[^/.]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function getProjectLabel(projectContext: ProjectContext | null | undefined): string | null {
  if (!projectContext) return null;
  if (projectContext.gitRemote) {
    const ownerRepo = extractOwnerRepo(projectContext.gitRemote);
    if (ownerRepo) return ownerRepo;
  }
  if (projectContext.cwd) {
    const parts = projectContext.cwd.split('/');
    return parts[parts.length - 1] || null;
  }
  return null;
}

export function Header({ connectionStatus, autoBuildState, autoBuildToggling, onToggleAutoBuild, projectContext, sidebarCollapsed, onToggleSidebar }: HeaderProps) {
  const projectLabel = getProjectLabel(projectContext);

  return (
    <header className="col-span-full bg-card border-b border-border px-6 py-3.5 flex items-center gap-3 shadow-sm shadow-black/30">
      <Button variant="ghost" size="icon" onClick={onToggleSidebar} className="h-7 w-7">
        {sidebarCollapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </Button>
      <h1 className="text-base font-bold text-text-bright tracking-tight">eforge</h1>
      {projectLabel && (
        <span className="text-xs text-text-dim">
          {projectLabel}
        </span>
      )}
      <div className="ml-auto text-xs flex items-center gap-2">
        {autoBuildState !== null && (
          <label className={cn('flex items-center gap-1.5 text-text-dim', autoBuildToggling ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
            <span>Auto-build</span>
            <Switch
              checked={autoBuildState.enabled}
              onCheckedChange={onToggleAutoBuild}
              disabled={autoBuildToggling}
            />
          </label>
        )}
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
