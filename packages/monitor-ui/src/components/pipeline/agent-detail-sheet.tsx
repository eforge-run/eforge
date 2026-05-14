import { useState } from 'react';
import { SheetContent } from '@/components/ui/sheet';
import { formatDuration, formatNumber } from '@/lib/format';
import type { AgentThread, AgentActivityFacts, StoredEvent } from '@/lib/reducer';
import type { EforgeEvent } from '@/lib/types';

const RESULT_TEXT_LIMIT = 600;

interface AgentDetailSheetProps {
  thread: AgentThread | null;
  events: StoredEvent[];
  open: boolean;
  onClose: () => void;
}

function AttributionBadge({ attribution }: { attribution: AgentActivityFacts['attribution'] }) {
  const colors: Record<AgentActivityFacts['attribution'], string> = {
    exact: 'bg-green-900/40 text-green-400 border-green-800',
    best_effort: 'bg-yellow-900/40 text-yellow-400 border-yellow-800',
    unavailable: 'bg-bg-tertiary text-text-dim border-border',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${colors[attribution]}`}>
      {attribution}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-text-dim shrink-0 w-28">{label}</span>
      <span className={`flex-1 text-foreground break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

export function AgentDetailSheet({ thread, events, open, onClose }: AgentDetailSheetProps) {
  const [resultExpanded, setResultExpanded] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [messagesExpanded, setMessagesExpanded] = useState(false);

  if (!thread) return null;

  const agentId = thread.agentId;

  // Derive events for this agent by filtering the full event log
  const warnings = events.filter(
    (se) =>
      se.event.type === 'agent:warning' &&
      'agentId' in se.event &&
      (se.event as { agentId: string }).agentId === agentId,
  );

  const retries = events.filter(
    (se) =>
      se.event.type === 'agent:retry' &&
      (se.event as { agent: string }).agent === thread.agent &&
      (se.event as { planId?: string }).planId === thread.planId,
  );

  const toolUses = events.filter(
    (se) =>
      se.event.type === 'agent:tool_use' &&
      'agentId' in se.event &&
      (se.event as { agentId: string }).agentId === agentId,
  );

  const messages = events.filter(
    (se) =>
      se.event.type === 'agent:message' &&
      'agentId' in se.event &&
      (se.event as { agentId: string }).agentId === agentId,
  );

  // Result text with truncation
  const fullText = thread.resultText ?? '';
  const truncated = fullText.length > RESULT_TEXT_LIMIT && !resultExpanded;
  const displayText = truncated ? fullText.slice(0, RESULT_TEXT_LIMIT) + '…' : fullText;

  // Lifecycle timestamps
  const startTime = new Date(thread.startedAt).toLocaleTimeString();
  const endTime = thread.endedAt ? new Date(thread.endedAt).toLocaleTimeString() : null;
  const duration =
    thread.durationMs != null
      ? formatDuration(thread.durationMs)
      : thread.endedAt
        ? formatDuration(new Date(thread.endedAt).getTime() - new Date(thread.startedAt).getTime())
        : 'running...';

  return (
    <SheetContent
      open={open}
      onClose={onClose}
      title={`${thread.agent} · ${thread.planId ?? 'global'}`}
      description={`Agent ID: ${agentId}`}
    >
      <div className="p-4 text-xs space-y-4">
        {/* Identity */}
        <Section title="Identity">
          <Row label="Role" value={thread.agent} />
          {thread.planId && <Row label="Plan" value={thread.planId} />}
          {thread.perspective && <Row label="Perspective" value={thread.perspective} />}
          <Row label="Agent ID" value={agentId} mono />
        </Section>

        {/* Runtime */}
        <Section title="Runtime">
          <Row label="Model" value={thread.model} mono />
          {thread.harness && (
            <Row
              label="Harness"
              value={`${thread.harness}${thread.harnessSource ? ` (${thread.harnessSource})` : ''}`}
            />
          )}
          {thread.tier && (
            <Row
              label="Tier"
              value={`${thread.tier}${thread.tierSource ? ` (${thread.tierSource})` : ''}`}
            />
          )}
          {thread.effort && (
            <Row
              label="Effort"
              value={
                thread.effortClamped && thread.effortOriginal
                  ? `${thread.effort} (clamped from ${thread.effortOriginal})`
                  : thread.effort
              }
            />
          )}
          {thread.thinking && <Row label="Thinking" value={thread.thinking} />}
          {thread.toolbelt !== undefined && (
            <Row
              label="Toolbelt"
              value={`${thread.toolbelt === null ? 'none' : thread.toolbelt}${thread.toolbeltSource ? ` (${thread.toolbeltSource})` : ''}`}
            />
          )}
        </Section>

        {/* Lifecycle */}
        <Section title="Lifecycle">
          <Row label="Start" value={startTime} />
          {endTime && <Row label="End" value={endTime} />}
          <Row label="Duration" value={duration} />
          {thread.numTurns != null && <Row label="Turns" value={String(thread.numTurns)} />}
        </Section>

        {/* Usage */}
        {(thread.inputTokens != null || thread.outputTokens != null || thread.costUsd != null) && (
          <Section title="Usage">
            {thread.inputTokens != null && (
              <Row label="Input tokens" value={formatNumber(thread.inputTokens)} />
            )}
            {thread.outputTokens != null && (
              <Row label="Output tokens" value={formatNumber(thread.outputTokens)} />
            )}
            {thread.totalTokens != null && (
              <Row label="Total tokens" value={formatNumber(thread.totalTokens)} />
            )}
            {thread.cacheRead != null && thread.cacheRead > 0 && (
              <Row label="Cache read" value={formatNumber(thread.cacheRead)} />
            )}
            {thread.costUsd != null && thread.costUsd > 0 && (
              <Row label="Cost" value={`$${thread.costUsd.toFixed(4)}`} />
            )}
          </Section>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <Section title={`Warnings (${warnings.length})`}>
            {warnings.map((se) => {
              const ev = se.event as Extract<EforgeEvent, { type: 'agent:warning' }>;
              return (
                <div key={se.eventId} className="text-yellow-400 text-[10px] font-mono py-0.5 break-words">
                  [{ev.code}] {ev.message}
                </div>
              );
            })}
          </Section>
        )}

        {/* Retries */}
        {retries.length > 0 && (
          <Section title={`Retries (${retries.length})`}>
            {retries.map((se) => {
              const ev = se.event as Extract<EforgeEvent, { type: 'agent:retry' }>;
              return (
                <div key={se.eventId} className="text-orange-400 text-[10px] py-0.5">
                  Attempt {ev.attempt}/{ev.maxAttempts}: {ev.label}
                </div>
              );
            })}
          </Section>
        )}

        {/* Activity facts */}
        {thread.activity && (
          <Section title="Files changed (deterministic)">
            <div className="flex items-center gap-2 mb-1.5">
              <AttributionBadge attribution={thread.activity.attribution} />
            </div>
            {thread.activity.totals && (
              <div className="text-[10px] text-text-dim mb-1.5">
                {thread.activity.totals.filesChanged} files · +{thread.activity.totals.additions}{' '}
                -{thread.activity.totals.deletions}
              </div>
            )}
            {thread.activity.files && thread.activity.files.length > 0 && (
              <div className="space-y-0.5">
                {thread.activity.files.map((f) => (
                  <div key={f.path} className="text-[10px] font-mono flex items-center gap-2">
                    <span className="text-text-dim truncate flex-1">{f.path}</span>
                    {f.additions != null && (
                      <span className="text-green-400 shrink-0">+{f.additions}</span>
                    )}
                    {f.deletions != null && (
                      <span className="text-red-400 shrink-0">-{f.deletions}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {thread.activity.notes && thread.activity.notes.length > 0 && (
              <div className="mt-1.5 space-y-0.5">
                {thread.activity.notes.map((note, i) => (
                  <div key={i} className="text-[10px] text-text-dim italic">
                    {note}
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        {/* Tool calls */}
        {toolUses.length > 0 && (
          <Section title={`Tool calls (${toolUses.length})`}>
            <button
              type="button"
              className="text-[10px] text-blue-400 underline mb-1"
              onClick={() => setToolsExpanded((v) => !v)}
            >
              {toolsExpanded ? 'Hide' : 'Show all'}
            </button>
            {toolsExpanded &&
              toolUses.map((se) => {
                const ev = se.event as Extract<EforgeEvent, { type: 'agent:tool_use' }>;
                return (
                  <div key={se.eventId} className="text-[10px] font-mono py-0.5 text-text-dim">
                    {ev.tool}
                  </div>
                );
              })}
          </Section>
        )}

        {/* Messages */}
        {messages.length > 0 && (
          <Section title={`Messages (${messages.length})`}>
            <button
              type="button"
              className="text-[10px] text-blue-400 underline"
              onClick={() => setMessagesExpanded((v) => !v)}
            >
              {messagesExpanded ? 'Hide' : 'Show all'}
            </button>
            {messagesExpanded &&
              messages.map((se) => {
                const ev = se.event as Extract<EforgeEvent, { type: 'agent:message' }>;
                return (
                  <div
                    key={se.eventId}
                    className="text-[10px] text-text-dim py-0.5 border-l-2 border-border pl-2 break-words"
                  >
                    {ev.content}
                  </div>
                );
              })}
          </Section>
        )}

        {/* Final result */}
        {fullText && (
          <Section title="Final result">
            <pre className="text-[10px] whitespace-pre-wrap break-words font-mono text-text-dim">
              {displayText}
            </pre>
            {fullText.length > RESULT_TEXT_LIMIT && (
              <button
                type="button"
                className="text-[10px] text-blue-400 underline mt-1"
                onClick={() => setResultExpanded((v) => !v)}
              >
                {resultExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </Section>
        )}
      </div>
    </SheetContent>
  );
}
