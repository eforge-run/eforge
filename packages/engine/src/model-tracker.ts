/**
 * ModelTracker — passive accumulator of model IDs observed during a build session.
 *
 * Records unique model identifiers from agent:start events. No I/O, no persistence,
 * no side effects — purely an in-memory Set<string> wrapper.
 *
 * Usage pattern:
 *   const tracker = new ModelTracker();
 *   // as events flow through:
 *   if (event.type === 'agent:start') tracker.record(event.model);
 *   // when composing a commit message:
 *   const message = composeCommitMessage(body, tracker);
 *   // forgeCommit will append Co-Authored-By after the Models-Used trailer
 *
 * See also: composeCommitMessage() below.
 */

export class ModelTracker {
  private readonly models = new Set<string>();

  /** Record a model ID. No-op if already recorded. */
  record(modelId: string): void {
    this.models.add(modelId);
  }

  /** Check whether a model ID has been recorded. */
  has(modelId: string): boolean {
    return this.models.has(modelId);
  }

  /** Number of unique model IDs recorded. */
  get size(): number {
    return this.models.size;
  }

  /** Merge another tracker's models into this one. */
  merge(other: ModelTracker): void {
    for (const id of other.models) {
      this.models.add(id);
    }
  }

  /**
   * Build the Models-Used trailer string.
   * Returns empty string when no models have been recorded.
   * Otherwise returns "Models-Used: <id1>, <id2>" with IDs sorted lexicographically.
   * No backend prefix — bare model IDs only (e.g. "claude-opus-4-5").
   */
  toTrailer(): string {
    if (this.models.size === 0) return '';
    const sorted = Array.from(this.models).sort();
    return `Models-Used: ${sorted.join(', ')}`;
  }
}

/**
 * Compose a commit message body with an optional Models-Used trailer.
 *
 * When the tracker is absent or empty, returns the body unchanged.
 * When non-empty, appends the Models-Used trailer separated by a blank line.
 *
 * Callers pass the result to forgeCommit(), which appends Co-Authored-By after it.
 * Final commit message ordering:
 *   <body>
 *
 *   Models-Used: <id1>, <id2>   ← appended here when tracker is non-empty
 *
 *   Co-Authored-By: forged-by-eforge <noreply@eforge.build>   ← appended by forgeCommit()
 */
export function composeCommitMessage(body: string, tracker?: ModelTracker): string {
  if (!tracker || tracker.size === 0) return body;
  return `${body}\n\n${tracker.toTrailer()}`;
}
