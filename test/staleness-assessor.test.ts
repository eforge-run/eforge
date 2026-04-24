import { describe, it, expect } from 'vitest';
import { StubHarness } from './stub-harness.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { runStalenessAssessor } from '@eforge-build/engine/agents/staleness-assessor';

describe('runStalenessAssessor wiring', () => {
  it('yields queue:prd:stale with proceed verdict', async () => {
    const backend = new StubHarness([{
      text: '<staleness verdict="proceed">PRD is still relevant, codebase changes are unrelated.</staleness>',
    }]);

    const events = await collectEvents(runStalenessAssessor({
      harness: backend,
      prdContent: '# Add auth\n\nImplement user authentication.',
      diffSummary: 'src/utils.ts | 5 ++',
      cwd: '/tmp',
    }));

    const stale = findEvent(events, 'queue:prd:stale');
    expect(stale).toBeDefined();
    expect(stale!.verdict).toBe('proceed');
    expect(stale!.justification).toBe('PRD is still relevant, codebase changes are unrelated.');
    expect(stale!.revision).toBeUndefined();
  });

  it('yields queue:prd:stale with revise verdict and revision content', async () => {
    const backend = new StubHarness([{
      text: '<staleness verdict="revise">API has changed since this PRD was written.<revision># Updated PRD\n\nRevised content here.</revision></staleness>',
    }]);

    const events = await collectEvents(runStalenessAssessor({
      harness: backend,
      prdContent: '# Old feature\n\nOutdated content.',
      diffSummary: 'src/api.ts | 50 +++---',
      cwd: '/tmp',
    }));

    const stale = findEvent(events, 'queue:prd:stale');
    expect(stale).toBeDefined();
    expect(stale!.verdict).toBe('revise');
    expect(stale!.justification).toBe('API has changed since this PRD was written.');
    expect(stale!.revision).toBe('# Updated PRD\n\nRevised content here.');
  });

  it('yields queue:prd:stale with obsolete verdict', async () => {
    const backend = new StubHarness([{
      text: '<staleness verdict="obsolete">This feature was already implemented in a different way.</staleness>',
    }]);

    const events = await collectEvents(runStalenessAssessor({
      harness: backend,
      prdContent: '# Feature X\n\nBuild feature X.',
      diffSummary: 'src/feature-x.ts | 200 ++++++',
      cwd: '/tmp',
    }));

    const stale = findEvent(events, 'queue:prd:stale');
    expect(stale).toBeDefined();
    expect(stale!.verdict).toBe('obsolete');
    expect(stale!.justification).toBe('This feature was already implemented in a different way.');
  });

  it('handles missing staleness block - no queue:prd:stale event emitted', async () => {
    const backend = new StubHarness([{
      text: 'The PRD looks fine to me. No issues found.',
    }]);

    const events = await collectEvents(runStalenessAssessor({
      harness: backend,
      prdContent: '# Feature\n\nContent.',
      diffSummary: '',
      cwd: '/tmp',
    }));

    const stale = findEvent(events, 'queue:prd:stale');
    expect(stale).toBeUndefined();
    // Should still have agent lifecycle events
    expect(findEvent(events, 'agent:start')).toBeDefined();
    expect(findEvent(events, 'agent:stop')).toBeDefined();
  });

  it('gates agent:message on verbose - suppressed when false', async () => {
    const backend = new StubHarness([{
      text: '<staleness verdict="proceed">Still good.</staleness>',
    }]);

    const events = await collectEvents(runStalenessAssessor({
      harness: backend,
      prdContent: '# Feature\n\nContent.',
      diffSummary: '',
      cwd: '/tmp',
      verbose: false,
    }));

    // agent:message should be suppressed when verbose is false
    expect(filterEvents(events, 'agent:message')).toHaveLength(0);
    // But agent:result should always be yielded
    expect(findEvent(events, 'agent:result')).toBeDefined();
  });

  it('emits agent:message when verbose is true', async () => {
    const backend = new StubHarness([{
      text: '<staleness verdict="proceed">Still good.</staleness>',
    }]);

    const events = await collectEvents(runStalenessAssessor({
      harness: backend,
      prdContent: '# Feature\n\nContent.',
      diffSummary: '',
      cwd: '/tmp',
      verbose: true,
    }));

    expect(filterEvents(events, 'agent:message').length).toBeGreaterThan(0);
  });
});
