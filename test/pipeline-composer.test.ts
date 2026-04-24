import { describe, it, expect } from 'vitest';
import { StubBackend } from './stub-backend.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { useTempDir } from './test-tmpdir.js';
import { composePipeline } from '@eforge-build/engine/agents/pipeline-composer';

const VALID_SEQUENTIAL = JSON.stringify({
  scope: 'errand',
  compile: ['planner'],
  defaultBuild: ['implement', 'test-write'],
  defaultReview: {
    strategy: 'single',
    perspectives: ['correctness'],
    maxRounds: 1,
    evaluatorStrictness: 'lenient',
  },
  rationale: 'Trivial change; sequential implement then test-write.',
});

const INVALID_PARALLEL = JSON.stringify({
  scope: 'errand',
  compile: ['planner'],
  // test-write declares implement as a predecessor — validatePipeline must reject this
  defaultBuild: [['implement', 'test-write']],
  defaultReview: {
    strategy: 'single',
    perspectives: ['correctness'],
    maxRounds: 1,
    evaluatorStrictness: 'lenient',
  },
  rationale: 'Parallel attempt.',
});

describe('composePipeline', () => {
  const makeTempDir = useTempDir('eforge-composer-test-');

  it('yields plan:pipeline on a valid first attempt', async () => {
    const backend = new StubBackend([{ resultText: VALID_SEQUENTIAL }]);
    const cwd = makeTempDir();

    const events = await collectEvents(composePipeline({
      backend,
      source: '# PRD\nAdd a /health endpoint.',
      cwd,
    }));

    const agentResults = filterEvents(events, 'agent:result');
    expect(agentResults).toHaveLength(1);

    const pipeline = findEvent(events, 'planning:pipeline');
    expect(pipeline).toBeDefined();
    expect(pipeline!.scope).toBe('errand');
    expect(pipeline!.defaultBuild).toEqual(['implement', 'test-write']);

    expect(backend.prompts).toHaveLength(1);
  });

  it('retries with prior output and error when validatePipeline rejects a parallel group', async () => {
    const backend = new StubBackend([
      { resultText: INVALID_PARALLEL },
      { resultText: VALID_SEQUENTIAL },
    ]);
    const cwd = makeTempDir();

    const events = await collectEvents(composePipeline({
      backend,
      source: '# PRD\nAdd a /health endpoint.',
      cwd,
    }));

    expect(filterEvents(events, 'agent:result')).toHaveLength(2);
    expect(findEvent(events, 'planning:pipeline')).toBeDefined();

    expect(backend.prompts).toHaveLength(2);
    const retryPrompt = backend.prompts[1];

    // Prior output is carried into the retry prompt — not just the error string.
    expect(retryPrompt).toContain('Your previous attempt produced:');
    expect(retryPrompt).toContain('[["implement","test-write"]]');
    // And the specific validatePipeline error is echoed back.
    expect(retryPrompt).toContain('That response was rejected:');
    expect(retryPrompt).toContain('predecessor "implement"');
  });

  it('throws after maxAttempts (3) when every response is unparseable', async () => {
    const backend = new StubBackend([
      { resultText: 'not json at all' },
      { resultText: 'still not json' },
      { resultText: 'nope' },
    ]);
    const cwd = makeTempDir();

    await expect(collectEvents(composePipeline({
      backend,
      source: '# PRD',
      cwd,
    }))).rejects.toThrow(/failed after 3 attempts/);

    expect(backend.prompts).toHaveLength(3);
  });
});
