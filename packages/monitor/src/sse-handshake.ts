import type { ServerResponse } from 'node:http';

/**
 * Write a `stream:hello` SSE frame as the first write on every new SSE connection.
 *
 * The frame format:
 *   event: stream:hello
 *   data: {"cursor":<n>, ...snapshotFields}
 *
 * No `id:` field is emitted — `stream:hello` is live-only and must never be
 * replayed on reconnect. Its cursor field sets the Last-Event-ID for the
 * current connection only. A reconnect emits a fresh `stream:hello` with a
 * fresh cursor.
 *
 * RULE: Any future SSE handler in the daemon MUST call `writeHello()` as its
 * first write on every connection, or fail review.
 *
 * @param res      HTTP ServerResponse to write to.
 * @param cursor   Current max event id for this stream (used as the
 *                 authoritative Last-Event-ID value for reconnects after
 *                 this frame).
 * @param snapshot Optional snapshot payload merged alongside `cursor`. Must
 *                 be a plain object (non-null, non-array).
 */
export function writeHello(res: ServerResponse, cursor: number, snapshot?: unknown): void {
  const data: Record<string, unknown> = {};
  if (snapshot !== null && snapshot !== undefined && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    Object.assign(data, snapshot);
  }
  // Set cursor last so it is authoritative — a snapshot field named `cursor`
  // must never override the explicit argument that drives Last-Event-ID.
  data.cursor = cursor;
  res.write(`event: stream:hello\ndata: ${JSON.stringify(data)}\n\n`);
}
