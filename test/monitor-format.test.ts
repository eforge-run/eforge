import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  formatNumber,
  formatTime,
  escapeHtml,
} from '../src/monitor/ui/src/lib/format';

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(59000)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(3599000)).toBe('59m 59s');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3600000)).toBe('1h 0m');
    expect(formatDuration(5400000)).toBe('1h 30m');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('handles negative values', () => {
    expect(formatDuration(-1000)).toBe('0s');
  });

  it('handles very large numbers', () => {
    expect(formatDuration(86400000)).toBe('24h 0m'); // 24 hours
  });
});

describe('formatNumber', () => {
  it('formats small numbers as-is', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
  });

  it('formats thousands with k suffix', () => {
    expect(formatNumber(1000)).toBe('1.0k');
    expect(formatNumber(1500)).toBe('1.5k');
    expect(formatNumber(999999)).toBe('1000.0k');
  });

  it('formats millions with M suffix', () => {
    expect(formatNumber(1000000)).toBe('1.0M');
    expect(formatNumber(2500000)).toBe('2.5M');
  });
});

describe('formatTime', () => {
  it('formats ISO time string', () => {
    const result = formatTime('2024-01-01T14:30:00Z');
    // Result depends on locale, just verify it returns something
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('handles empty string', () => {
    expect(formatTime('')).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('passes through plain text', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});
