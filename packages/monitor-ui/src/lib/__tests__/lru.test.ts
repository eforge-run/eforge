import { describe, it, expect } from 'vitest';
import { BoundedMap } from '../lru';

describe('BoundedMap — insertion-order LRU (non-promoting hits)', () => {
  it('accepts up to the capacity limit and all entries are accessible', () => {
    const m = new BoundedMap<string, number>(20);
    for (let i = 0; i < 20; i++) {
      m.set(`key-${i}`, i);
    }
    expect(m.size).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(m.get(`key-${i}`)).toBe(i);
    }
  });

  it('21st insert evicts the oldest (first-inserted) entry', () => {
    const m = new BoundedMap<string, number>(20);
    for (let i = 0; i < 20; i++) {
      m.set(`key-${i}`, i);
    }
    // key-0 is the oldest
    m.set('key-20', 20);
    expect(m.size).toBe(20);
    expect(m.has('key-0')).toBe(false);  // evicted
    expect(m.has('key-20')).toBe(true);  // newest
    expect(m.has('key-1')).toBe(true);   // still present
  });

  it('hit on existing key does NOT promote it — insertion order still governs eviction', () => {
    // Policy: non-promoting. Reading key-0 does NOT make it the newest entry.
    // After a hit on key-0 and then inserting a 21st entry, key-0 is STILL evicted
    // because it remains the oldest by insertion order.
    const m = new BoundedMap<string, number>(20);
    for (let i = 0; i < 20; i++) {
      m.set(`key-${i}`, i);
    }
    // Access key-0 — should NOT promote it
    expect(m.get('key-0')).toBe(0);

    // Insert 21st entry — key-0 (oldest by insertion) should still be evicted
    m.set('key-20', 20);
    expect(m.has('key-0')).toBe(false);  // NOT promoted by the hit — still evicted
    expect(m.has('key-20')).toBe(true);
  });

  it('overwriting an existing key does not grow the map beyond capacity', () => {
    const m = new BoundedMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    m.set('a', 99); // overwrite, not a new insert
    expect(m.size).toBe(3);
    expect(m.get('a')).toBe(99);
  });

  it('evicts in insertion order across multiple inserts', () => {
    const m = new BoundedMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    m.set('d', 4); // evicts 'a'
    m.set('e', 5); // evicts 'b'
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(false);
    expect(m.has('c')).toBe(true);
    expect(m.has('d')).toBe(true);
    expect(m.has('e')).toBe(true);
    expect(m.size).toBe(3);
  });
});
