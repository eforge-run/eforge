import { describe, it, expect } from 'vitest';
import { shortenPath } from '../src/monitor/ui/src/lib/format';

describe('shortenPath', () => {
  it('returns short paths unchanged', () => {
    expect(shortenPath('src/a.ts', 50)).toBe('src/a.ts');
  });

  it('truncates deep paths preserving filename', () => {
    // 63 chars total, maxChars=50
    // Greedily includes from right: …/src/components/preview/plan-preview-context.tsx (48 chars, fits)
    expect(
      shortenPath('src/monitor/ui/src/components/preview/plan-preview-context.tsx', 50),
    ).toBe('…/src/components/preview/plan-preview-context.tsx');
  });

  it('greedily includes trailing parent dirs from right to left', () => {
    // 'a/b/c/d/file.ts' with maxChars=20
    // 'a/b/c/d/file.ts' = 15 chars, fits within 20 → returned unchanged
    expect(shortenPath('a/b/c/d/file.ts', 20)).toBe('a/b/c/d/file.ts');

    // Force truncation with a tighter limit
    // 'a/b/c/d/file.ts' = 15 chars
    // '…/d/file.ts' = 11 chars, fits in 12
    // '…/c/d/file.ts' = 13 chars, doesn't fit in 12
    expect(shortenPath('a/b/c/d/file.ts', 12)).toBe('…/d/file.ts');
  });

  it('prepends …/ when truncation occurs', () => {
    const result = shortenPath('very/deep/nested/path/to/some/file.ts', 20);
    expect(result.startsWith('…/')).toBe(true);
    expect(result.endsWith('file.ts')).toBe(true);
  });

  it('returns …/filename when filename alone exceeds maxChars', () => {
    expect(shortenPath('a/b.ts', 3)).toBe('…/b.ts');
  });

  it('never truncates the filename itself', () => {
    const longName = 'a-very-long-component-filename.tsx';
    expect(shortenPath(`deep/path/${longName}`, 10)).toBe(`…/${longName}`);
  });

  it('returns empty string for empty input', () => {
    expect(shortenPath('', 50)).toBe('');
  });

  it('returns single-segment paths unchanged', () => {
    expect(shortenPath('file.ts', 50)).toBe('file.ts');
    expect(shortenPath('file.ts', 3)).toBe('file.ts');
  });

  it('respects custom maxChars values', () => {
    const path = 'src/components/ui/button.tsx'; // 28 chars
    expect(shortenPath(path, 100)).toBe(path);
    expect(shortenPath(path, 28)).toBe(path); // exact length
    expect(shortenPath(path, 15)).toBe('…/ui/button.tsx');
  });
});
