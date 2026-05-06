/**
 * Unit tests for writeHello (sse-handshake.ts).
 *
 * Covers:
 * - Named SSE event field (`event: stream:hello`) is present.
 * - Cursor is embedded in the data JSON.
 * - Snapshot fields are merged into the data JSON alongside cursor.
 * - No `id:` field on the frame (stream:hello must not be replayed on reconnect).
 * - Frame ends with the required double-newline SSE boundary.
 *
 * Follows AGENTS.md conventions:
 * - No mocks. Uses a minimal stub that captures res.write() calls.
 * - Constructs inputs inline.
 */

import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';
import { writeHello } from '../sse-handshake.js';

/** Minimal stub capturing res.write() output. */
function makeStubResponse(): { writes: string[]; res: ServerResponse } {
  const writes: string[] = [];
  const res = {
    write: (data: string) => {
      writes.push(data);
      return true;
    },
  } as unknown as ServerResponse;
  return { writes, res };
}

describe('writeHello', () => {
  it('emits the named SSE event field "event: stream:hello"', () => {
    const { writes, res } = makeStubResponse();
    writeHello(res, 42);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^event: stream:hello\n/);
  });

  it('embeds cursor in the data JSON', () => {
    const { writes, res } = makeStubResponse();
    writeHello(res, 99);
    const dataLine = writes[0].split('\n').find((l) => l.startsWith('data:'));
    expect(dataLine).toBeDefined();
    const data = JSON.parse(dataLine!.slice('data: '.length));
    expect(data.cursor).toBe(99);
  });

  it('merges snapshot fields alongside cursor', () => {
    const { writes, res } = makeStubResponse();
    writeHello(res, 10, { liveness: { type: 'daemon:heartbeat' }, extra: 'val' });
    const dataLine = writes[0].split('\n').find((l) => l.startsWith('data:'));
    const data = JSON.parse(dataLine!.slice('data: '.length));
    expect(data.cursor).toBe(10);
    expect(data.liveness).toEqual({ type: 'daemon:heartbeat' });
    expect(data.extra).toBe('val');
  });

  it('does not include an id: field on the frame', () => {
    const { writes, res } = makeStubResponse();
    writeHello(res, 5);
    expect(writes[0]).not.toMatch(/^id:/m);
  });

  it('frame ends with double-newline SSE boundary', () => {
    const { writes, res } = makeStubResponse();
    writeHello(res, 0);
    expect(writes[0]).toMatch(/\n\n$/);
  });

  it('emits only cursor when no snapshot is provided', () => {
    const { writes, res } = makeStubResponse();
    writeHello(res, 7);
    const dataLine = writes[0].split('\n').find((l) => l.startsWith('data:'));
    const data = JSON.parse(dataLine!.slice('data: '.length));
    expect(Object.keys(data)).toEqual(['cursor']);
    expect(data.cursor).toBe(7);
  });

  it('ignores null and non-object snapshot values', () => {
    const { writes: w1, res: r1 } = makeStubResponse();
    writeHello(r1, 1, null);
    const d1 = JSON.parse(w1[0].split('\n').find((l) => l.startsWith('data:'))!.slice('data: '.length));
    expect(Object.keys(d1)).toEqual(['cursor']);

    const { writes: w2, res: r2 } = makeStubResponse();
    writeHello(r2, 2, 'string');
    const d2 = JSON.parse(w2[0].split('\n').find((l) => l.startsWith('data:'))!.slice('data: '.length));
    expect(Object.keys(d2)).toEqual(['cursor']);
  });

  it('ignores arrays as snapshot values (Array.isArray guard)', () => {
    // Arrays are typeof 'object' so they would slip past a naive object check —
    // the implementation has an explicit Array.isArray() guard. Verify it.
    const { writes, res } = makeStubResponse();
    writeHello(res, 3, [{ a: 1 }, { b: 2 }] as unknown);
    const data = JSON.parse(writes[0].split('\n').find((l) => l.startsWith('data:'))!.slice('data: '.length));
    expect(Object.keys(data)).toEqual(['cursor']);
    expect(data.cursor).toBe(3);
  });

  it('explicit cursor arg wins over a snapshot field named cursor', () => {
    // A snapshot that itself carries a `cursor` key must not override the
    // authoritative cursor argument — the explicit arg drives Last-Event-ID.
    const { writes, res } = makeStubResponse();
    writeHello(res, 7, { cursor: 999, extra: 'data' });
    const dataLine = writes[0].split('\n').find((l) => l.startsWith('data:'));
    const data = JSON.parse(dataLine!.slice('data: '.length));
    expect(data.cursor).toBe(7); // explicit arg must win
    expect(data.extra).toBe('data'); // other snapshot fields are still merged
  });

  it('emits exactly one write() call per hello frame', () => {
    const { writes, res } = makeStubResponse();
    writeHello(res, 100, { a: 1, b: 2 });
    expect(writes).toHaveLength(1);
  });
});
