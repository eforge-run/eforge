import { describe, it, expect } from 'vitest';
import {
  getVerdictChipClass,
  getConfidenceClass,
  type RecoveryVerdictValue,
  type RecoveryConfidenceValue,
} from '../verdict-chip';

// Pure logic tests for RecoveryVerdictChip color-mapping functions.
// These do not render React components — they validate the classification
// contract that drives the chip's visual appearance.

describe('getVerdictChipClass', () => {
  it('maps retry to blue', () => {
    expect(getVerdictChipClass('retry')).toContain('text-blue');
  });

  it('maps split to yellow', () => {
    expect(getVerdictChipClass('split')).toContain('text-yellow');
  });

  it('maps abandon to red', () => {
    expect(getVerdictChipClass('abandon')).toContain('text-red');
  });

  it('maps manual to gray (text-dim)', () => {
    expect(getVerdictChipClass('manual')).toContain('text-text-dim');
  });

  it('returns a non-empty class for every verdict', () => {
    const verdicts: RecoveryVerdictValue[] = ['retry', 'split', 'abandon', 'manual'];
    verdicts.forEach((v) => {
      const cls = getVerdictChipClass(v);
      expect(cls.trim().length).toBeGreaterThan(0);
    });
  });
});

describe('getConfidenceClass', () => {
  it('maps high confidence to green', () => {
    expect(getConfidenceClass('high')).toContain('text-green');
  });

  it('maps medium confidence to yellow', () => {
    expect(getConfidenceClass('medium')).toContain('text-yellow');
  });

  it('maps low confidence to red', () => {
    expect(getConfidenceClass('low')).toContain('text-red');
  });

  it('returns a non-empty class for every confidence level', () => {
    const levels: RecoveryConfidenceValue[] = ['low', 'medium', 'high'];
    levels.forEach((c) => {
      const cls = getConfidenceClass(c);
      expect(cls.trim().length).toBeGreaterThan(0);
    });
  });
});

describe('verdict × confidence matrix', () => {
  const verdicts: RecoveryVerdictValue[] = ['retry', 'split', 'abandon', 'manual'];
  const confidences: RecoveryConfidenceValue[] = ['low', 'medium', 'high'];

  verdicts.forEach((verdict) => {
    confidences.forEach((confidence) => {
      it(`verdict=${verdict} confidence=${confidence} — both return non-empty strings`, () => {
        expect(getVerdictChipClass(verdict)).toBeTruthy();
        expect(getConfidenceClass(confidence)).toBeTruthy();
      });
    });
  });
});
