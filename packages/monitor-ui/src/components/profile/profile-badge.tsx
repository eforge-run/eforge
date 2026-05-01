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

interface TierRecipeEntry {
  harness?: string;
  pi?: { provider?: string };
  model?: string;
  effort?: string;
}

interface ProfileConfigShape {
  extends?: string;
  agents?: {
    tiers?: Record<string, TierRecipeEntry>;
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

      {/* Tier Recipes */}
      {cfg.agents?.tiers && Object.keys(cfg.agents.tiers).length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] uppercase tracking-wider text-text-dim font-semibold">Tiers</h3>
          <div className="flex flex-col gap-2">
            {Object.entries(cfg.agents.tiers).map(([tier, entry]) => (
              <div key={tier} className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground text-xs">{tier}</span>
                <div className="flex items-center gap-2 text-[10px] text-text-dim pl-2">
                  {entry.harness && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">{entry.harness}</Badge>
                  )}
                  {entry.pi?.provider && (
                    <span>provider: {entry.pi.provider}</span>
                  )}
                  {entry.model && (
                    <span>{entry.model}</span>
                  )}
                  {entry.effort && (
                    <span>effort: {entry.effort}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Role overrides */}
      {cfg.agents?.roles && Object.keys(cfg.agents.roles).length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] uppercase tracking-wider text-text-dim font-semibold">Roles</h3>
          <div className="flex flex-col gap-1">
            {Object.entries(cfg.agents.roles).map(([role, overrides]) => (
              <div key={role} className="flex items-start gap-2">
                <span className="text-text-dim w-28 shrink-0">{role}</span>
                <span className="text-foreground text-[11px] break-all">{JSON.stringify(overrides)}</span>
              </div>
            ))}
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
