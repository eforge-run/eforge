import { describe, it, expect } from 'vitest';
import { formatDate, truncate } from '../src/utils/format.js';

describe('Format Utils', () => {
  describe('formatDate', () => {
    it('formats an ISO date string', () => {
      const result = formatDate('2024-01-15T10:30:00.000Z');
      expect(result).toContain('Jan');
      expect(result).toContain('15');
      expect(result).toContain('2024');
    });
  });

  describe('truncate', () => {
    it('returns short strings unchanged', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates long strings with ellipsis', () => {
      const result = truncate('this is a very long string', 10);
      expect(result).toBe('this is...');
      expect(result.length).toBe(10);
    });

    it('returns string unchanged when exactly at max length', () => {
      expect(truncate('12345', 5)).toBe('12345');
    });
  });
});
