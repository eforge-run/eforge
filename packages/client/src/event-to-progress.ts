/**
 * This module maps engine-emitted `EforgeEvent`s (defined in
 * `@eforge-build/engine/events`) onto the wire-format `DaemonStreamEvent`
 * (defined in this package) that consumers receive over
 * `/api/events/:session` SSE. The engine event is the source of truth;
 * `DaemonStreamEvent` is its serialized form. When engine events grow a new
 * field, update the mapper and `DaemonStreamEvent` together.
 *
 * Shared event -> progress mapping for `eforge_follow` consumers.
 *
 * The MCP proxy (`packages/eforge/src/cli/mcp-proxy.ts`) and the Pi extension
 * (`packages/pi-eforge/extensions/eforge/index.ts`) both follow a running
 * eforge session and surface high-signal events to the caller: MCP via
 * `notifications/progress`, Pi via the tool's `onUpdate(message)` callback.
 *
 * To prevent the two consumer surfaces from drifting on event messages, the
 * mapping lives here - a single source of truth for which daemon events are
 * high-signal and how they render as human-readable strings.
 *
 * The mapping is intentionally narrow: only `phase:start`, `phase:end`,
 * `build:files_changed`, high/critical `review:issue`, `build:failed`, and
 * `phase:error` produce updates. Everything else - especially the noisy
 * `agent:*` event family - is filtered.
 */
import type { DaemonStreamEvent } from './session-stream.js';

/** Running counters accumulated across events in a single follow subscription. */
export interface FollowCounters {
  filesChanged: number;
}

/** A single progress update derived from a daemon event. */
export interface ProgressUpdate {
  message: string;
  /** Updated counters after this event; callers advance their own monotonic progress index. */
  counters: FollowCounters;
}

/**
 * Map a daemon event to a progress update. Returns `null` for events that
 * should be filtered (noisy `agent:*` events, low-severity review issues, or
 * any type not in the high-signal set).
 *
 * Callers pass the current `counters` and receive back the updated counters so
 * running totals (e.g. files changed) can be surfaced in the message.
 */
export function eventToProgress(
  event: DaemonStreamEvent,
  counters: FollowCounters,
): ProgressUpdate | null {
  const type = event.type;
  if (typeof type !== 'string') return null;

  // Explicitly filter the noisy agent event family.
  if (type.startsWith('agent:')) return null;

  switch (type) {
    case 'phase:start': {
      const phase = (event.phase ?? event.command ?? event.planSet) as string | undefined;
      const label = phase ?? 'unknown';
      return { message: `Phase: ${label} starting`, counters };
    }
    case 'phase:end': {
      const phase = (event.phase ?? event.command ?? event.planSet) as string | undefined;
      const label = phase ?? 'unknown';
      return { message: `Phase: ${label} complete`, counters };
    }
    case 'plan:build:files_changed': {
      const files = (event as { files?: unknown }).files;
      const delta = Array.isArray(files) ? files.length : 0;
      const nextCounters: FollowCounters = {
        ...counters,
        filesChanged: counters.filesChanged + delta,
      };
      return {
        message: `Files changed: ${delta} (total ${nextCounters.filesChanged})`,
        counters: nextCounters,
      };
    }
    case 'review:issue': {
      const severity = (event as { severity?: unknown }).severity;
      if (severity !== 'high' && severity !== 'critical') return null;
      const summary = ((event as { summary?: unknown }).summary
        ?? (event as { description?: unknown }).description
        ?? (event as { message?: unknown }).message
        ?? 'review issue') as string;
      return { message: `Issue (${severity}): ${summary}`, counters };
    }
    case 'plan:build:failed': {
      const planId = (event as { planId?: unknown }).planId as string | undefined;
      const error = (event as { error?: unknown }).error as string | undefined;
      const label = planId ? `${planId}: ${error ?? 'failed'}` : (error ?? 'failed');
      return { message: `Build failed: ${label}`, counters };
    }
    case 'phase:error': {
      const error = (event as { error?: unknown }).error as string | undefined;
      return { message: `Phase error: ${error ?? 'failed'}`, counters };
    }
    default:
      return null;
  }
}
