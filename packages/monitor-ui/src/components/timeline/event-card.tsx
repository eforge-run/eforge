import { useState } from 'react';
import type { EforgeEvent } from '@/lib/types';
import { formatDuration, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePlanPreview } from '@/components/preview';
import { Button } from '@/components/ui/button';

interface EventCardProps {
  event: EforgeEvent;
  startTime: number | null;
  showVerbose: boolean;
}

function classifyEvent(type: string, event: EforgeEvent): { cls: string; label: string } {
  if (type === 'phase:start') return { cls: 'start', label: type };
  if (type === 'phase:end') {
    const status = 'result' in event ? (event as { result?: { status?: string } }).result?.status : undefined;
    return { cls: status === 'failed' ? 'failed' : 'complete', label: type };
  }
  if (type === 'validation:command:timeout') return { cls: 'failed', label: type };
  if (type.endsWith(':start')) return { cls: 'start', label: type };
  if (type.endsWith(':complete')) return { cls: 'complete', label: type };
  if (type.endsWith(':failed')) return { cls: 'failed', label: type };
  if (type.endsWith(':skipped')) return { cls: 'info', label: type };
  if (type.endsWith(':progress')) return { cls: 'progress', label: type };
  if (type.startsWith('agent:')) return { cls: 'agent', label: type };
  if (type === 'planning:skip' || type === 'plan:profile' || type === 'planning:clarification') return { cls: 'info', label: type };
  return { cls: 'info', label: type };
}

function eventSummary(event: EforgeEvent): string {
  switch (event.type) {
    case 'phase:start': return `Run started: ${event.command} "${event.planSet}"`;
    case 'phase:end': return `Run ${event.result?.status}: ${event.result?.summary || ''}`;
    case 'planning:start': {
      const display = event.label ?? (event.source.length > 80 ? event.source.slice(0, 77) + '...' : event.source);
      return `Planning from: ${display}`;
    }
    case 'planning:skip': return `Skipped: ${event.reason}`;
    case 'plan:profile' as string: return `Profile: ${(event as unknown as { profileName: string; rationale: string }).profileName} — ${(event as unknown as { profileName: string; rationale: string }).rationale}`;
    case 'planning:clarification': return `${event.questions?.length || 0} clarification question(s)`;
    case 'planning:progress': return event.message;
    case 'planning:complete': return `${event.plans?.length || 0} plan(s) generated`;
    case 'planning:review:start': return 'Plan review started';
    case 'planning:review:complete': return `Plan review: ${event.issues?.length || 0} issue(s)`;
    case 'planning:evaluate:start': return 'Evaluating plan review fixes';
    case 'planning:evaluate:complete': return `Accepted ${event.accepted}, rejected ${event.rejected}`;
    case 'planning:architecture:review:start': return 'Architecture review started';
    case 'planning:architecture:review:complete': return `Architecture review: ${event.issues?.length || 0} issue(s)`;
    case 'planning:architecture:evaluate:start': return 'Evaluating architecture review fixes';
    case 'planning:architecture:evaluate:complete': return `Accepted ${event.accepted}, rejected ${event.rejected}`;
    case 'plan:build:start': return `Building: ${event.planId}`;
    case 'plan:build:implement:start': return `Implementing: ${event.planId}`;
    case 'plan:build:implement:progress': return `[${event.planId}] ${event.message}`;
    case 'plan:build:implement:complete': return `Implementation complete: ${event.planId}`;
    case 'plan:build:review:start': return `Reviewing: ${event.planId}`;
    case 'plan:build:review:complete': return `[${event.planId}] Review: ${event.issues?.length || 0} issue(s)`;
    case 'plan:build:evaluate:start': return `Evaluating: ${event.planId}`;
    case 'plan:build:evaluate:complete': return `[${event.planId}] Accepted ${event.accepted}, rejected ${event.rejected}`;
    case 'plan:build:test:write:start': return `Writing tests: ${event.planId}`;
    case 'plan:build:test:write:complete': return `[${event.planId}] ${event.testsWritten} test(s) written`;
    case 'plan:build:test:start': return `Running tests: ${event.planId}`;
    case 'plan:build:test:complete': return `[${event.planId}] Tests: ${event.passed} passed, ${event.failed} failed${event.productionIssues?.length ? `, ${event.productionIssues.length} production issue(s)` : ''}`;
    case 'plan:build:complete': return `Build complete: ${event.planId}`;
    case 'plan:build:failed': return `Build FAILED: ${event.planId} — ${event.error}`;
    case 'schedule:start': return `Scheduling: ${event.planIds?.join(', ')}`;
    case 'plan:schedule:ready': return `Ready: ${event.planId} (${event.reason})`;
    case 'plan:merge:start': return `Merging: ${event.planId}`;
    case 'plan:merge:complete': return `Merged: ${event.planId}`;
    case 'merge:finalize:start': return `Finalizing: ${event.featureBranch} → ${event.baseBranch}`;
    case 'merge:finalize:complete': return `Finalized: ${event.featureBranch} → ${event.baseBranch}`;
    case 'merge:finalize:skipped': return `Finalize skipped: ${event.reason}`;
    case 'expedition:architecture:complete': return `Architecture: ${event.modules?.length || 0} module(s)`;
    case 'expedition:module:start': return `Module planning: ${event.moduleId}`;
    case 'expedition:module:complete': return `Module complete: ${event.moduleId}`;
    case 'expedition:compile:start': return 'Compiling expedition plans';
    case 'expedition:compile:complete': return `Compiled ${event.plans?.length || 0} plan(s)`;
    case 'agent:message': return `[${event.agent}] message`;
    case 'agent:tool_use': return `[${event.agent}] ${event.tool}`;
    case 'agent:tool_result': return `[${event.agent}] ${event.tool} result`;
    case 'agent:result': return `[${event.agent}] done — ${event.result?.usage?.total || 0} tokens, ${((event.result?.durationMs ?? 0) / 1000).toFixed(1)}s`;
    case 'validation:start': return `Validation: ${event.commands?.length || 0} command(s)`;
    case 'validation:command:start': return `Running: ${event.command}`;
    case 'validation:command:complete': return `${event.command}: exit ${event.exitCode}`;
    case 'validation:command:timeout': return `${event.command}: timed out (${event.timeoutMs}ms)`;
    case 'validation:complete': return event.passed ? 'Validation passed' : 'Validation failed';
    case 'validation:fix:start': return `Fix attempt ${event.attempt}/${event.maxAttempts}`;
    case 'validation:fix:complete': return `Fix attempt ${event.attempt} complete`;
    case 'prd_validation:start': return 'PRD Validation started';
    case 'prd_validation:complete': {
      const pct = event.completionPercent !== undefined ? `${event.completionPercent}% complete, ` : '';
      return event.passed ? `PRD Validation: ${pct}passed` : `PRD Validation: ${pct}${event.gaps?.length || 0} gap(s) found`;
    }
    case 'gap_close:start': {
      const gapCount = 'gapCount' in event ? (event as { gapCount?: number }).gapCount : undefined;
      return gapCount !== undefined ? `Gap closing: ${gapCount} gap(s)` : 'Gap closing started';
    }
    case 'gap_close:plan_ready': {
      const gaps = 'gaps' in event ? (event as { gaps?: unknown[] }).gaps : undefined;
      return `Gap close plan ready: ${gaps?.length || 0} gap(s) addressed`;
    }
    case 'gap_close:complete': return 'Gap closing complete';
    case 'approval:needed': return `Approval needed: ${event.action}`;
    case 'approval:response': return event.approved ? 'Approved' : 'Rejected';
    case 'enqueue:start': return `Enqueuing from: ${event.source}`;
    case 'enqueue:complete': return `Enqueued: ${event.title} → ${event.filePath}`;
    case 'enqueue:failed': return `Enqueue failed: ${event.error}`;
    default: return event.type;
  }
}

function eventDetail(event: EforgeEvent): string | null {
  switch (event.type) {
    case 'plan:profile' as string: {
      const _ev = event as unknown as { config?: { compile?: string[]; agents?: Record<string, Record<string, unknown>> }; rationale?: string };
      if (!_ev.config) return _ev.rationale ?? null;
      const parts: string[] = [];
      {
        const c = _ev.config;
        parts.push(`Compile: ${c.compile?.join(' → ') ?? '—'}`);
        const agents = Object.entries((c as Record<string, unknown>)['agents'] as Record<string, Record<string, unknown>> ?? {});
        if (agents.length > 0) {
          parts.push('Agents:');
          for (const [role, cfg] of agents) {
            const fields = [];
            if (cfg.maxTurns) fields.push(`turns=${cfg.maxTurns}`);
            if (cfg.tools) fields.push(`tools=${cfg.tools}`);
            if (cfg.model) fields.push(`model=${cfg.model}`);
            if (cfg.prompt) fields.push(`prompt=${cfg.prompt}`);
            if (fields.length > 0) parts.push(`  ${role}: ${fields.join(', ')}`);
          }
        }
      }
      return parts.join('\n');
    }
    case 'planning:clarification':
      return event.questions?.map((q) => `Q: ${q.question}${q.context ? '\n   ' + q.context : ''}`).join('\n\n') ?? null;
    case 'planning:review:complete':
    case 'planning:architecture:review:complete':
    case 'plan:build:review:complete':
      return event.issues?.map((i) => `[${i.severity}] ${i.category} — ${i.file}${i.line ? ':' + i.line : ''}\n  ${i.description}`).join('\n\n') ?? null;
    case 'agent:message':
      return event.content;
    case 'agent:tool_use':
      return typeof event.input === 'string' ? event.input : JSON.stringify(event.input, null, 2);
    case 'agent:tool_result':
      return event.output;
    case 'agent:result': {
      if (!event.result) return null;
      const r = event.result;
      let detail = `Duration: ${(r.durationMs / 1000).toFixed(1)}s (API: ${(r.durationApiMs / 1000).toFixed(1)}s)`;
      const cacheRead = r.usage?.cacheRead || 0;
      const inputTokens = r.usage?.input || 0;
      const cachePct = cacheRead > 0 && inputTokens > 0 ? ` (${Math.round(cacheRead / inputTokens * 100)}% cached)` : '';
      detail += `\nTokens: ${formatNumber(inputTokens)} in / ${formatNumber(r.usage?.output || 0)} out${cachePct}`;
      detail += `\nTurns: ${r.numTurns}`;
      if (r.totalCostUsd) detail += `\nCost: $${r.totalCostUsd.toFixed(4)}`;
      if (r.modelUsage) {
        detail += '\nModels:';
        for (const [model, usage] of Object.entries(r.modelUsage)) {
          const modelCacheRead = usage.cacheReadInputTokens || 0;
          const modelCachePct = modelCacheRead > 0 && usage.inputTokens > 0 ? ` (${Math.round(modelCacheRead / usage.inputTokens * 100)}% cached)` : '';
          detail += `\n  ${model}: ${formatNumber(usage.inputTokens)} in / ${formatNumber(usage.outputTokens)} out${modelCachePct} ($${usage.costUSD.toFixed(4)})`;
        }
      }
      return detail;
    }
    case 'plan:build:failed':
      return event.error;
    case 'enqueue:failed':
      return event.error;
    case 'plan:build:test:complete': {
      const parts: string[] = [];
      parts.push(`Passed: ${event.passed}, Failed: ${event.failed}`);
      if (event.testBugsFixed > 0) parts.push(`Test bugs fixed: ${event.testBugsFixed}`);
      if (event.productionIssues?.length) {
        parts.push('Production issues:');
        for (const issue of event.productionIssues) {
          parts.push(`  [${issue.severity}] ${issue.category} — ${issue.file}\n    ${issue.description}`);
        }
      }
      return parts.join('\n');
    }
    case 'phase:end':
      return event.result?.summary ?? null;
    case 'expedition:architecture:complete':
      return event.modules?.map((m) => `${m.id}: ${m.description}${m.dependsOn?.length ? ' (depends: ' + m.dependsOn.join(', ') + ')' : ''}`).join('\n') ?? null;
    case 'validation:command:complete':
      return event.output || null;
    case 'validation:command:timeout':
      return `Command killed after ${event.timeoutMs}ms (pid ${event.pid}). The process group was terminated.`;
    case 'prd_validation:complete': {
      if (event.passed) return 'All PRD requirements satisfied.';
      const gapParts: string[] = [];
      for (const gap of (event.gaps ?? [])) {
        const complexitySuffix = gap.complexity ? ` [${gap.complexity}]` : '';
        gapParts.push(`Requirement: ${gap.requirement}${complexitySuffix}\n  Gap: ${gap.explanation}`);
      }
      return gapParts.join('\n\n') || null;
    }
    case 'gap_close:plan_ready': {
      const gaps = 'gaps' in event ? (event as { gaps?: Array<{ requirement: string; explanation: string; complexity?: string }> }).gaps : undefined;
      if (!gaps?.length) return null;
      return gaps.map((g) => {
        const complexitySuffix = g.complexity ? ` [${g.complexity}]` : '';
        return `Requirement: ${g.requirement}${complexitySuffix}\n  Gap: ${g.explanation}`;
      }).join('\n\n');
    }
    default:
      return null;
  }
}

function getEventPlanId(event: EforgeEvent): string | undefined {
  if ('planId' in event && typeof (event as { planId?: string }).planId === 'string') {
    return (event as { planId: string }).planId;
  }
  return undefined;
}

export function EventCard({ event, startTime, showVerbose }: EventCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { openPreview, openContentPreview } = usePlanPreview();
  const typeInfo = classifyEvent(event.type, event);
  const isVerbose = event.type.startsWith('agent:');
  const planId = getEventPlanId(event);

  // Hide verbose events when toggle is off
  if (isVerbose && !showVerbose) return null;

  const elapsed =
    startTime && 'timestamp' in event && (event as { timestamp?: string }).timestamp
      ? formatDuration(new Date((event as { timestamp: string }).timestamp).getTime() - startTime)
      : '';

  const summary = eventSummary(event);
  const detail = eventDetail(event);

  const typeClasses: Record<string, string> = {
    start: 'bg-blue/15 text-blue',
    complete: 'bg-green/15 text-green',
    failed: 'bg-red/15 text-red',
    progress: 'bg-yellow/15 text-yellow',
    agent: 'bg-muted-foreground/10 text-text-dim',
    info: 'bg-purple/15 text-purple',
  };

  return (
    <div
      className={cn(
        'px-2 py-1 flex items-start gap-2.5',
        isVerbose && 'opacity-50',
      )}
    >
      <span
        className={cn(
          'text-[11px] font-semibold px-1.5 py-px rounded-sm whitespace-nowrap min-w-[100px] text-center',
          typeClasses[typeInfo.cls] || typeClasses.info,
        )}
      >
        {typeInfo.label}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-foreground">
          {summary}
          {planId && (
            <>
              {' '}
              <span
                className="text-blue cursor-pointer hover:underline font-mono text-[11px]"
                onClick={() => openPreview(planId)}
              >
                {planId === 'gap-close' ? 'PRD Gap Close' : planId}
              </span>
            </>
          )}
          {event.type === 'planning:start' && event.source.includes('\n') && (
            <>
              {' '}
              <span
                className="text-blue cursor-pointer hover:underline text-[11px]"
                onClick={() => openContentPreview(event.label ?? 'PRD Source', event.source)}
              >
                view source
              </span>
            </>
          )}
        </div>
        {detail && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto p-0"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? 'hide' : 'details'}
            </Button>
            {isExpanded && (
              <div className="text-text-dim text-[11px] mt-1 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                {detail}
              </div>
            )}
          </>
        )}
      </div>
      <span className="text-[11px] text-text-dim whitespace-nowrap">{elapsed}</span>
    </div>
  );
}
