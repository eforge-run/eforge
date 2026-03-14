import { describe, it, expect } from 'vitest';
import {
  getStatusStyle,
  resolveNodeStatus,
  type GraphNodeStatus,
} from '../src/monitor/ui/src/components/graph/graph-status';

describe('getStatusStyle', () => {
  const allStatuses: GraphNodeStatus[] = [
    'pending',
    'running',
    'implement',
    'review',
    'evaluate',
    'complete',
    'failed',
    'blocked',
    'merged',
  ];

  it.each(allStatuses)('returns valid style for status: %s', (status) => {
    const style = getStatusStyle(status);
    expect(style.color).toBeTruthy();
    expect(style.bgColor).toBeTruthy();
    expect(style.icon).toBeTruthy();
    expect(typeof style.animated).toBe('boolean');
  });

  it('returns fallback style for unknown status', () => {
    const style = getStatusStyle('nonexistent');
    expect(style.icon).toBe('?');
    expect(style.animated).toBe(false);
  });

  it('active statuses have animated: true', () => {
    expect(getStatusStyle('running').animated).toBe(true);
    expect(getStatusStyle('implement').animated).toBe(true);
    expect(getStatusStyle('review').animated).toBe(true);
    expect(getStatusStyle('evaluate').animated).toBe(true);
  });

  it('terminal statuses have animated: false', () => {
    expect(getStatusStyle('pending').animated).toBe(false);
    expect(getStatusStyle('complete').animated).toBe(false);
    expect(getStatusStyle('failed').animated).toBe(false);
    expect(getStatusStyle('blocked').animated).toBe(false);
    expect(getStatusStyle('merged').animated).toBe(false);
  });
});

describe('resolveNodeStatus', () => {
  it('returns pipeline status when available', () => {
    expect(resolveNodeStatus('p1', 'implement', new Set())).toBe('implement');
    expect(resolveNodeStatus('p1', 'review', new Set())).toBe('review');
    expect(resolveNodeStatus('p1', 'complete', new Set())).toBe('complete');
    expect(resolveNodeStatus('p1', 'failed', new Set())).toBe('failed');
  });

  it('returns pending when no pipeline status', () => {
    expect(resolveNodeStatus('p1', undefined, new Set())).toBe('pending');
  });

  it('returns merged when planId is in merged set, regardless of pipeline status', () => {
    expect(resolveNodeStatus('p1', 'complete', new Set(['p1']))).toBe('merged');
    expect(resolveNodeStatus('p1', undefined, new Set(['p1']))).toBe('merged');
  });

  it('does not return merged for plans not in merged set', () => {
    expect(resolveNodeStatus('p1', 'complete', new Set(['p2']))).toBe('complete');
  });
});
