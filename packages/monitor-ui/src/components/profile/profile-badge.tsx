import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { stringify as stringifyYaml } from 'yaml';
import { codeToHtml } from 'shiki';
import { Badge } from '@/components/ui/badge';
import { SheetContent } from '@/components/ui/sheet';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import type { SessionProfile } from '@/lib/types';

interface ProfileBadgeProps {
  profile: SessionProfile;
}

function sourceScopeBadgeText(source: SessionProfile['source'], _scope: SessionProfile['scope']): string {
  if (source === 'none' || source === 'missing') return '';
  if (source === 'local') return 'project-local';
  if (source === 'project') return 'project';
  if (source === 'user-local') return 'user';
  return source;
}

function RawYamlBlock({ config }: { config: unknown }) {
  const [html, setHtml] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || html !== null) return;
    let cancelled = false;
    const yamlText = typeof config === 'string' ? config : stringifyYaml(config ?? {});
    codeToHtml(yamlText, {
      lang: 'yaml',
      theme: 'github-dark',
    }).then((result) => {
      if (!cancelled) setHtml(result);
    }).catch(() => {
      if (!cancelled) setHtml(`<pre class="text-xs">${yamlText}</pre>`);
    });
    return () => { cancelled = true; };
  }, [open, config, html]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="flex items-center gap-1 text-[11px] text-text-dim hover:text-foreground transition-colors">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Raw YAML
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 rounded-md overflow-auto max-h-80 text-[11px]">
          {html
            // eslint-disable-next-line react/no-danger
            ? <div dangerouslySetInnerHTML={{ __html: html }} />
            : <pre className="text-text-dim p-2">{typeof config === 'string' ? config : stringifyYaml(config ?? {})}</pre>
          }
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface AgentRuntimeEntry {
  harness?: string;
  pi?: { provider?: string };
  claudeSdk?: unknown;
}

interface ProfileConfigShape {
  agentRuntimes?: Record<string, AgentRuntimeEntry>;
  defaultAgentRuntime?: string;
  extends?: string;
  agents?: {
    models?: Record<string, unknown>;
    tiers?: Record<string, unknown>;
    roles?: Record<string, unknown>;
  };
}

function ProfileSheetBody({ profile }: { profile: SessionProfile }) {
  if (profile.config === null || profile.config === undefined) {
    return (
      <div className="p-4 text-xs text-text-dim italic">
        No profile configuration available for this session.
      </div>
    );
  }

  const cfg = profile.config as ProfileConfigShape;
  const subBadgeText = sourceScopeBadgeText(profile.source, profile.scope);

  return (
    <div className="p-4 flex flex-col gap-5 text-xs">
      {/* Header */}
      <div className="flex flex-col gap-1.5">
        <span className="font-semibold text-sm text-foreground">{profile.profileName}</span>
        {subBadgeText && (
          <span className="text-[10px] text-text-dim">{subBadgeText}</span>
        )}
      </div>

      {/* Agent Runtimes */}
      {cfg.agentRuntimes && Object.keys(cfg.agentRuntimes).length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] uppercase tracking-wider text-text-dim font-semibold">Agent Runtimes</h3>
          <div className="flex flex-col gap-1.5">
            {Object.entries(cfg.agentRuntimes).map(([name, entry]) => (
              <div key={name} className="flex items-center gap-2 text-xs">
                <span className="font-medium text-foreground">{name}</span>
                {entry.harness && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">{entry.harness}</Badge>
                )}
                {entry.pi?.provider && (
                  <span className="text-text-dim text-[10px]">provider: {entry.pi.provider}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Default Runtime */}
      {cfg.defaultAgentRuntime && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[10px] uppercase tracking-wider text-text-dim font-semibold">Default Runtime</h3>
          <span className="text-foreground">{cfg.defaultAgentRuntime}</span>
        </section>
      )}

      {/* Agents overrides */}
      {cfg.agents && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] uppercase tracking-wider text-text-dim font-semibold">Agents</h3>
          <div className="flex flex-col gap-2">
            {cfg.agents.models && Object.keys(cfg.agents.models).length > 0 && (
              <div>
                <span className="text-[10px] text-text-dim uppercase tracking-wide">Models</span>
                <div className="mt-1 flex flex-col gap-1">
                  {Object.entries(cfg.agents.models).map(([cls, ref]) => (
                    <div key={cls} className="flex items-center gap-2">
                      <span className="text-text-dim w-20">{cls}</span>
                      <span className="text-foreground">{typeof ref === 'object' && ref !== null ? (ref as { id?: string }).id ?? JSON.stringify(ref) : String(ref)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {cfg.agents.tiers && Object.keys(cfg.agents.tiers).length > 0 && (
              <div>
                <span className="text-[10px] text-text-dim uppercase tracking-wide">Tiers</span>
                <div className="mt-1 flex flex-col gap-1">
                  {Object.entries(cfg.agents.tiers).map(([tier, overrides]) => (
                    <div key={tier} className="flex items-start gap-2">
                      <span className="text-text-dim w-20 shrink-0">{tier}</span>
                      <span className="text-foreground text-[11px] break-all">{JSON.stringify(overrides)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {cfg.agents.roles && Object.keys(cfg.agents.roles).length > 0 && (
              <div>
                <span className="text-[10px] text-text-dim uppercase tracking-wide">Roles</span>
                <div className="mt-1 flex flex-col gap-1">
                  {Object.entries(cfg.agents.roles).map(([role, overrides]) => (
                    <div key={role} className="flex items-start gap-2">
                      <span className="text-text-dim w-28 shrink-0">{role}</span>
                      <span className="text-foreground text-[11px] break-all">{JSON.stringify(overrides)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Extends */}
      {cfg.extends && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[10px] uppercase tracking-wider text-text-dim font-semibold">Extends</h3>
          <span className="text-foreground">{cfg.extends}</span>
        </section>
      )}

      {/* Raw YAML */}
      <section>
        <RawYamlBlock config={profile.config} />
      </section>
    </div>
  );
}

export function ProfileBadge({ profile }: ProfileBadgeProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus:outline-none"
      >
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 cursor-pointer hover:bg-secondary/60 transition-colors"
        >
          {profile.profileName}
        </Badge>
      </button>
      <SheetContent
        open={open}
        onClose={() => setOpen(false)}
        title="Profile"
        description={profile.profileName ?? undefined}
      >
        <ProfileSheetBody profile={profile} />
      </SheetContent>
    </>
  );
}
