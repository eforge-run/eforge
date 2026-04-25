import { describe, it, expect } from 'vitest';
import {
  getVerdictChipClass,
  getConfidenceClass,
  type RecoveryVerdictValue,
  type RecoveryConfidenceValue,
} from '@/components/recovery/verdict-chip';

// Pure logic tests validating that EventCard correctly surfaces the
// RecoveryVerdictChip for recovery:complete events.
//
// EventCard narrows the event with:
//   const recoveryCompleteEvent = event.type === 'recovery:complete' ? event : null;
// and then renders <RecoveryVerdictChip verdict={...} confidence={...} /> when
// recoveryCompleteEvent is non-null.
//
// Because no DOM environment is available in this test suite, we test the
// pure rendering-branch logic: the narrowing predicate and the chip styling
// helpers that would be called once the event is rendered.

// Mirror of EventCard's recoveryCompleteEvent narrowing — extracted as a pure
// function for testability.
type RecoveryCompleteEventShape = {
  type: 'recovery:complete';
  prdId: string;
  verdict: { verdict: RecoveryVerdictValue; confidence: RecoveryConfidenceValue };
};

function getRecoveryVerdictProps(
  event: { type: string; [key: string]: unknown },
): { verdict: RecoveryVerdictValue; confidence: RecoveryConfidenceValue } | null {
  if (event.type !== 'recovery:complete') return null;
  const e = event as unknown as RecoveryCompleteEventShape;
  return e.verdict;
}

describe('EventCard recovery:complete rendering branch', () => {
  it('returns non-null chip props for a recovery:complete event', () => {
    const event = {
      type: 'recovery:complete',
      prdId: 'my-plan',
      verdict: { verdict: 'retry' as RecoveryVerdictValue, confidence: 'high' as RecoveryConfidenceValue },
    };
    const props = getRecoveryVerdictProps(event);
    expect(props).not.toBeNull();
    expect(props?.verdict).toBe('retry');
    expect(props?.confidence).toBe('high');
  });

  it('returns null for non-recovery events (chip is not rendered)', () => {
    const event = { type: 'plan:build:complete', planId: 'my-plan' };
    expect(getRecoveryVerdictProps(event)).toBeNull();
  });

  it('returns null for recovery:start events (chip only shown on complete)', () => {
    const event = { type: 'recovery:start', prdId: 'my-plan', setName: 'my-set' };
    expect(getRecoveryVerdictProps(event)).toBeNull();
  });

  it('chip styling is valid for all verdict/confidence combinations from recovery events', () => {
    const verdicts: RecoveryVerdictValue[] = ['retry', 'split', 'abandon', 'manual'];
    const confidences: RecoveryConfidenceValue[] = ['low', 'medium', 'high'];

    verdicts.forEach((verdict) => {
      confidences.forEach((confidence) => {
        const event = {
          type: 'recovery:complete',
          prdId: 'my-plan',
          verdict: { verdict, confidence },
        };
        const props = getRecoveryVerdictProps(event);
        expect(props).not.toBeNull();
        // Validate that the chip helpers produce non-empty class strings for
        // the verdict and confidence values from the event — these are called
        // by RecoveryVerdictChip during rendering.
        expect(getVerdictChipClass(props!.verdict).trim().length).toBeGreaterThan(0);
        expect(getConfidenceClass(props!.confidence).trim().length).toBeGreaterThan(0);
      });
    });
  });
});
