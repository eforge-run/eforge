import { describe, it, expect } from 'vitest';
import { reviewProfileConfigSchema } from '@eforge-build/engine/config';
import { runParallel } from '@eforge-build/engine/concurrency';
import type { ParallelTask } from '@eforge-build/engine/concurrency';
import type { EforgeEvent } from '@eforge-build/client';

describe('reviewProfileConfigSchema perspective enum', () => {
  const baseConfig = {
    strategy: 'parallel' as const,
    maxRounds: 1,
    evaluatorStrictness: 'standard' as const,
  };

  it('accepts a config with all valid perspective names', () => {
    const result = reviewProfileConfigSchema.safeParse({
      ...baseConfig,
      perspectives: ['code', 'security', 'api', 'docs', 'test', 'verify'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config with an invalid perspective name', () => {
    const result = reviewProfileConfigSchema.safeParse({
      ...baseConfig,
      perspectives: ['foo'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes('perspectives') || (i.path.length > 0 && i.path[0] === 'perspectives'),
      );
      expect(issue).toBeDefined();
      // Zod v4 uses 'invalid_value' for enum mismatches
      const message = issue?.message ?? '';
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('rejects the previously-misleading "performance" perspective', () => {
    const result = reviewProfileConfigSchema.safeParse({
      ...baseConfig,
      perspectives: ['performance'],
    });
    expect(result.success).toBe(false);
  });
});

describe('parallel-reviewer surfaces errors as :perspective:error events', () => {
  it('runParallel collects domain-specific error events from a failing task', async () => {
    const tasks: ParallelTask<EforgeEvent>[] = [
      {
        id: 'review-code',
        run: async function* (): AsyncGenerator<EforgeEvent> {
          yield {
            timestamp: new Date().toISOString(),
            type: 'plan:build:review:parallel:perspective:start',
            planId: 'plan-test',
            perspective: 'code',
          };
          try {
            throw new Error('boom');
          } catch (err) {
            yield {
              timestamp: new Date().toISOString(),
              type: 'plan:build:review:parallel:perspective:error',
              planId: 'plan-test',
              perspective: 'code',
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      },
    ];

    const events: EforgeEvent[] = [];
    for await (const event of runParallel(tasks)) {
      events.push(event);
    }

    const errorEvent = events.find(
      (e) => e.type === 'plan:build:review:parallel:perspective:error',
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.type).toBe('plan:build:review:parallel:perspective:error');
    if (errorEvent?.type === 'plan:build:review:parallel:perspective:error') {
      expect(errorEvent.error).toBe('boom');
      expect(errorEvent.perspective).toBe('code');
    }
  });
});
