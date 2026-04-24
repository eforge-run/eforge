import { describe, it, expect } from 'vitest';
import type { EforgeEvent } from '@eforge-build/engine/events';
import { AgentTerminalError } from '@eforge-build/engine/backend';
import { StubBackend } from './stub-backend.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { useTempDir } from './test-tmpdir.js';
import { builderImplement } from '@eforge-build/engine/agents/builder';
import { DEFAULT_CONFIG } from '@eforge-build/engine/config';
import { parseOrchestrationConfig } from '@eforge-build/engine/plan';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const makePlanFile = (id = 'plan-01') => ({
  id,
  name: 'Test Plan',
  dependsOn: [],
  branch: 'test/main',
  body: '# Test\n\nImplement something.',
  filePath: '/tmp/test-plan.md',
});

// --- builderImplement without continuation ---

describe('builderImplement without continuation', () => {
  const makeTempDir = useTempDir('eforge-continuation-test-');

  it('succeeds without continuation on normal completion', async () => {
    const backend = new StubBackend([{ text: 'Implementation complete.' }]);
    const cwd = makeTempDir();
    const plan = makePlanFile();

    const events = await collectEvents(builderImplement(plan, {
      backend,
      cwd,
    }));

    expect(findEvent(events, 'plan:build:implement:start')).toBeDefined();
    expect(findEvent(events, 'plan:build:implement:complete')).toBeDefined();
    expect(findEvent(events, 'plan:build:failed')).toBeUndefined();
    // No continuation events
    const continuations = filterEvents(events, 'plan:build:implement:continuation' as EforgeEvent['type']);
    expect(continuations).toHaveLength(0);
  });

  it('emits build:failed on error_max_turns without continuation context', async () => {
    const backend = new StubBackend([{
      error: new AgentTerminalError('error_max_turns', 'Reached maximum number of turns (50).'),
    }]);
    const cwd = makeTempDir();
    const plan = makePlanFile();

    const events = await collectEvents(builderImplement(plan, {
      backend,
      cwd,
    }));

    expect(findEvent(events, 'plan:build:implement:start')).toBeDefined();
    const failed = findEvent(events, 'plan:build:failed');
    expect(failed).toBeDefined();
    expect(failed!.error).toContain('error_max_turns');
    expect(failed!.terminalSubtype).toBe('error_max_turns');
    expect(findEvent(events, 'plan:build:implement:complete')).toBeUndefined();
  });

  it('emits build:failed on non-max_turns errors', async () => {
    const backend = new StubBackend([{
      error: new Error('Agent builder failed: some_other_error'),
    }]);
    const cwd = makeTempDir();
    const plan = makePlanFile();

    const events = await collectEvents(builderImplement(plan, {
      backend,
      cwd,
    }));

    const failed = findEvent(events, 'plan:build:failed');
    expect(failed).toBeDefined();
    expect(failed!.error).toContain('some_other_error');
    expect(failed!.error).not.toContain('error_max_turns');
  });
});

// --- builderImplement with continuation context ---

describe('builderImplement with continuation context', () => {
  const makeTempDir = useTempDir('eforge-continuation-ctx-test-');

  it('includes continuation context in prompt when provided', async () => {
    const backend = new StubBackend([{ text: 'Continued implementation.' }]);
    const cwd = makeTempDir();
    const plan = makePlanFile();

    await collectEvents(builderImplement(plan, {
      backend,
      cwd,
      continuationContext: {
        attempt: 1,
        maxContinuations: 3,
        completedDiff: 'diff --git a/foo.ts b/foo.ts\n+added line',
      },
    }));

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    expect(prompt).toContain('Continuation Context');
    expect(prompt).toContain('continuation attempt 1 of 3');
    expect(prompt).toContain('diff --git a/foo.ts b/foo.ts');
    expect(prompt).toContain('Do NOT redo any of the completed work');
  });

  it('does not include continuation context when not provided', async () => {
    const backend = new StubBackend([{ text: 'Normal implementation.' }]);
    const cwd = makeTempDir();
    const plan = makePlanFile();

    await collectEvents(builderImplement(plan, {
      backend,
      cwd,
    }));

    expect(backend.prompts).toHaveLength(1);
    const prompt = backend.prompts[0];
    expect(prompt).not.toContain('Continuation Context');
    expect(prompt).not.toContain('continuation attempt');
  });
});

// --- Config: maxContinuations ---

describe('maxContinuations config', () => {
  it('DEFAULT_CONFIG has maxContinuations = 3', () => {
    expect(DEFAULT_CONFIG.agents.maxContinuations).toBe(3);
  });
});

// --- OrchestrationConfig: maxContinuations per-plan ---

describe('parseOrchestrationConfig with maxContinuations', () => {
  const makeTempDir = useTempDir('eforge-orch-config-test-');

  it('parses maxContinuations from plan entries', async () => {
    const dir = makeTempDir();
    const orchYaml = `
name: test-set
description: Test
created: "2024-01-01"
mode: errand
base_branch: main
pipeline:
  scope: errand
  compile:
    - planner
  defaultBuild:
    - implement
    - review-cycle
  defaultReview:
    strategy: auto
    perspectives:
      - code
    maxRounds: 1
    evaluatorStrictness: standard
  rationale: test
plans:
  - id: plan-01
    name: Test Plan
    depends_on: []
    branch: test/main
    max_continuations: 5
    build:
      - implement
      - review-cycle
    review:
      strategy: auto
      perspectives:
        - code
      maxRounds: 1
      evaluatorStrictness: standard
`;
    const orchPath = join(dir, 'orchestration.yaml');
    writeFileSync(orchPath, orchYaml);

    const config = await parseOrchestrationConfig(orchPath);
    expect(config.plans[0].maxContinuations).toBe(5);
  });

  it('omits maxContinuations when not specified', async () => {
    const dir = makeTempDir();
    const orchYaml = `
name: test-set
description: Test
created: "2024-01-01"
mode: errand
base_branch: main
pipeline:
  scope: errand
  compile:
    - planner
  defaultBuild:
    - implement
    - review-cycle
  defaultReview:
    strategy: auto
    perspectives:
      - code
    maxRounds: 1
    evaluatorStrictness: standard
  rationale: test
plans:
  - id: plan-01
    name: Test Plan
    depends_on: []
    branch: test/main
    build:
      - implement
      - review-cycle
    review:
      strategy: auto
      perspectives:
        - code
      maxRounds: 1
      evaluatorStrictness: standard
`;
    const orchPath = join(dir, 'orchestration.yaml');
    writeFileSync(orchPath, orchYaml);

    const config = await parseOrchestrationConfig(orchPath);
    expect(config.plans[0].maxContinuations).toBeUndefined();
  });
});

// --- EforgeEvent type: build:implement:continuation ---

describe('build:implement:continuation event type', () => {
  it('is a valid EforgeEvent', () => {
    // Type-check: this should compile without errors
    const event: EforgeEvent = {
      type: 'plan:build:implement:continuation',
      planId: 'plan-01',
      attempt: 1,
      maxContinuations: 3,
    };
    expect(event.type).toBe('plan:build:implement:continuation');
    expect(event.attempt).toBe(1);
    expect(event.maxContinuations).toBe(3);
  });
});
