import type { AgentRole } from '@/lib/types';
import type { AgentThread, StoredEvent } from '@/lib/reducer';
import type { StageStatus } from './agent-stage-map';

/** Map agent roles to pipeline-stage color classes */
export const AGENT_COLORS: Record<AgentRole, { bg: string; border: string }> = {
  'planner':                { bg: 'bg-yellow/30',  border: 'border-yellow/50' },
  'module-planner':         { bg: 'bg-yellow/30',  border: 'border-yellow/50' },
  'builder':                { bg: 'bg-blue/30',    border: 'border-blue/50' },
  'reviewer':               { bg: 'bg-green/30',   border: 'border-green/50' },
  'review-fixer':           { bg: 'bg-green/30',   border: 'border-green/50' },
  'plan-reviewer':          { bg: 'bg-green/30',   border: 'border-green/50' },
  'cohesion-reviewer':      { bg: 'bg-green/30',   border: 'border-green/50' },
  'architecture-reviewer':  { bg: 'bg-green/30',   border: 'border-green/50' },
  'evaluator':              { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'plan-evaluator':         { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'architecture-evaluator': { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'cohesion-evaluator':     { bg: 'bg-purple/30',  border: 'border-purple/50' },
  'doc-author':             { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'doc-syncer':             { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'validation-fixer':       { bg: 'bg-red/30',     border: 'border-red/50' },
  'formatter':              { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'tester':                 { bg: 'bg-orange/30',  border: 'border-orange/50' },
  'test-writer':            { bg: 'bg-orange/30',  border: 'border-orange/50' },
  'merge-conflict-resolver': { bg: 'bg-red/30',    border: 'border-red/50' },
  'staleness-assessor':     { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'prd-validator':          { bg: 'bg-orange/30',  border: 'border-orange/50' },
  'gap-closer':            { bg: 'bg-pink/30',    border: 'border-pink/50' },
  'dependency-detector':   { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'pipeline-composer':     { bg: 'bg-cyan/30',    border: 'border-cyan/50' },
  'recovery-analyst':      { bg: 'bg-orange/30',  border: 'border-orange/50' },
};

export const FALLBACK_COLOR = { bg: 'bg-cyan/30', border: 'border-cyan/50' };
export const EMPTY_THREADS: AgentThread[] = [];
export const EMPTY_EVENTS: StoredEvent[] = [];
export const EMPTY_SET = new Set<string>();

// --- Pill constants for artifact labels ---

export const pillClass =
  'inline-flex items-center h-auto px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer transition-colors border-none';
export const prdPillClass = `${pillClass} bg-yellow/15 text-yellow/70 hover:bg-yellow/25 hover:text-yellow/90`;
export const planPillClass = `${pillClass} bg-cyan/15 text-cyan/70 hover:bg-cyan/25 hover:text-cyan/90`;

export const DEPTH_BAR_BG = [
  'bg-cyan/40', 'bg-blue/40', 'bg-purple/40',
  'bg-green/40', 'bg-yellow/40', 'bg-orange/40', 'bg-pink/40',
];

export const DEPTH_PILL_CLASS = [
  `${pillClass} bg-cyan/15 text-cyan/70 hover:bg-cyan/25 hover:text-cyan/90`,
  `${pillClass} bg-blue/15 text-blue/70 hover:bg-blue/25 hover:text-blue/90`,
  `${pillClass} bg-purple/15 text-purple/70 hover:bg-purple/25 hover:text-purple/90`,
  `${pillClass} bg-green/15 text-green/70 hover:bg-green/25 hover:text-green/90`,
  `${pillClass} bg-yellow/15 text-yellow/70 hover:bg-yellow/25 hover:text-yellow/90`,
  `${pillClass} bg-orange/15 text-orange/70 hover:bg-orange/25 hover:text-orange/90`,
  `${pillClass} bg-pink/15 text-pink/70 hover:bg-pink/25 hover:text-pink/90`,
];

export const planPillClassFor = (d: number) => DEPTH_PILL_CLASS[d % DEPTH_PILL_CLASS.length];

export function abbreviatePlanId(id: string): string {
  if (id === 'gap-close') return 'Gap Close';
  const match = id.match(/^plan-(\d+)/);
  if (match) return `Plan ${match[1]}`;
  return id;
}

export function getAgentColor(agent: string) {
  return AGENT_COLORS[agent as AgentRole] ?? FALLBACK_COLOR;
}

// --- Profile tier colors ---

export const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  errand: { bg: 'bg-[#3fb950]/15', text: 'text-[#3fb950]', border: 'border-[#3fb950]/30' },
  excursion: { bg: 'bg-[#58a6ff]/15', text: 'text-[#58a6ff]', border: 'border-[#58a6ff]/30' },
  expedition: { bg: 'bg-[#f0883e]/15', text: 'text-[#f0883e]', border: 'border-[#f0883e]/30' },
};

export const DEFAULT_TIER = { bg: 'bg-[#bc8cff]/15', text: 'text-[#bc8cff]', border: 'border-[#bc8cff]/30' };

export function getTierColor(name: string) {
  return TIER_COLORS[name] ?? DEFAULT_TIER;
}

export const STAGE_STATUS_STYLES: Record<StageStatus, string> = {
  pending: 'bg-bg-tertiary text-text-dim/80',
  active: 'bg-primary/20 text-primary',
  completed: 'bg-green/15 text-green/70',
  failed: 'bg-red/15 text-red/70',
};
