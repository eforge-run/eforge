import { describe, it, expect } from 'vitest';
import {
  handlePlanBuildStart,
  handlePlanBuildImplementStart,
  handlePlanBuildDocAuthorStart,
  handlePlanBuildDocAuthorComplete,
  handlePlanBuildDocSyncStart,
  handlePlanBuildDocSyncComplete,
  handlePlanBuildImplementComplete,
  handlePlanBuildTestWriteStart,
  handlePlanBuildTestWriteComplete,
  handlePlanBuildTestStart,
  handlePlanBuildTestComplete,
  handlePlanBuildReviewStart,
  handlePlanBuildReviewComplete,
  handlePlanBuildEvaluateStart,
  handlePlanBuildComplete,
  handlePlanBuildFailed,
  handlePlanBuildFilesChanged,
  handlePlanMergeComplete,
} from '../handle-plan-build';
import { initialRunState } from '../../reducer';
import type { EforgeEvent } from '../../types';

function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
): Extract<EforgeEvent, { type: T }> {
  return { type, timestamp: '2024-01-15T10:00:00.000Z', sessionId: 's1', ...extra } as unknown as Extract<EforgeEvent, { type: T }>;
}

const PLAN_ID = 'plan-01';

describe('handle-plan-build — stage advancement rules', () => {
  // ---------------------------------------------------------------------------
  // Stage advancements
  // ---------------------------------------------------------------------------
  it('plan:build:start → implements stage', () => {
    const event = makeEvent('plan:build:start', { planId: PLAN_ID });
    const delta = handlePlanBuildStart(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('implement');
  });

  it('plan:build:implement:start → implement stage', () => {
    const event = makeEvent('plan:build:implement:start', { planId: PLAN_ID });
    const delta = handlePlanBuildImplementStart(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('implement');
  });

  it('plan:build:doc-author:start → does NOT advance stage (parallel with implement)', () => {
    const state = { ...initialRunState, planStatuses: { [PLAN_ID]: 'implement' as const } };
    const event = makeEvent('plan:build:doc-author:start', { planId: PLAN_ID });
    const delta = handlePlanBuildDocAuthorStart(event, state);
    expect(delta).toBeUndefined();
  });

  it('plan:build:doc-author:complete → does NOT advance stage', () => {
    const state = { ...initialRunState, planStatuses: { [PLAN_ID]: 'implement' as const } };
    const event = makeEvent('plan:build:doc-author:complete', { planId: PLAN_ID, docsAuthored: 2 });
    const delta = handlePlanBuildDocAuthorComplete(event, state);
    expect(delta).toBeUndefined();
  });

  it('plan:build:doc-sync:start → doc-sync stage (sequential after implement)', () => {
    const state = { ...initialRunState, planStatuses: { [PLAN_ID]: 'implement' as const } };
    const event = makeEvent('plan:build:doc-sync:start', { planId: PLAN_ID });
    const delta = handlePlanBuildDocSyncStart(event, state);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('doc-sync');
  });

  it('plan:build:doc-sync:complete → does NOT advance stage (next stage sets it)', () => {
    const state = { ...initialRunState, planStatuses: { [PLAN_ID]: 'doc-sync' as const } };
    const event = makeEvent('plan:build:doc-sync:complete', { planId: PLAN_ID, docsSynced: 1 });
    const delta = handlePlanBuildDocSyncComplete(event, state);
    expect(delta).toBeUndefined();
  });

  it('plan:build:implement:complete → does NOT advance stage (next stage sets it)', () => {
    const state = { ...initialRunState, planStatuses: { [PLAN_ID]: 'implement' as const } };
    const event = makeEvent('plan:build:implement:complete', { planId: PLAN_ID });
    const delta = handlePlanBuildImplementComplete(event, state);
    expect(delta).toBeUndefined();
  });

  it('plan:build:test:write:start → test stage', () => {
    const event = makeEvent('plan:build:test:write:start', { planId: PLAN_ID });
    const delta = handlePlanBuildTestWriteStart(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('test');
  });

  it('plan:build:test:write:complete → does NOT advance stage', () => {
    const state = { ...initialRunState, planStatuses: { [PLAN_ID]: 'test' as const } };
    const event = makeEvent('plan:build:test:write:complete', { planId: PLAN_ID, testsWritten: 3 });
    const delta = handlePlanBuildTestWriteComplete(event, state);
    expect(delta).toBeUndefined();
  });

  it('plan:build:test:start → test stage', () => {
    const event = makeEvent('plan:build:test:start', { planId: PLAN_ID });
    const delta = handlePlanBuildTestStart(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('test');
  });

  it('plan:build:review:start → review stage', () => {
    const event = makeEvent('plan:build:review:start', { planId: PLAN_ID });
    const delta = handlePlanBuildReviewStart(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('review');
  });

  it('plan:build:review:complete → evaluate stage + extracts reviewIssues', () => {
    const issues = [{ severity: 'warning', category: 'style', file: 'a.ts', description: 'Missing docs' }];
    const event = makeEvent('plan:build:review:complete', { planId: PLAN_ID, issues });
    const delta = handlePlanBuildReviewComplete(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('evaluate');
    expect(delta?.reviewIssues?.[PLAN_ID]).toEqual(issues);
  });

  it('plan:build:evaluate:start → evaluate stage', () => {
    const event = makeEvent('plan:build:evaluate:start', { planId: PLAN_ID });
    const delta = handlePlanBuildEvaluateStart(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('evaluate');
  });

  it('plan:build:complete → complete stage', () => {
    const event = makeEvent('plan:build:complete', { planId: PLAN_ID });
    const delta = handlePlanBuildComplete(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('complete');
  });

  it('plan:build:failed → failed stage', () => {
    const event = makeEvent('plan:build:failed', { planId: PLAN_ID, error: 'compilation error' });
    const delta = handlePlanBuildFailed(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('failed');
  });

  // ---------------------------------------------------------------------------
  // File changes
  // ---------------------------------------------------------------------------
  it('plan:build:files_changed updates fileChanges Map', () => {
    const files = ['src/a.ts', 'src/b.ts'];
    const event = makeEvent('plan:build:files_changed', { planId: PLAN_ID, files });
    const delta = handlePlanBuildFilesChanged(event, initialRunState);
    expect(delta?.fileChanges?.get(PLAN_ID)).toEqual(files);
  });

  it('plan:build:files_changed preserves existing entries for other plans', () => {
    const OTHER = 'plan-02';
    const state = { ...initialRunState, fileChanges: new Map([[OTHER, ['x.ts']]]) };
    const event = makeEvent('plan:build:files_changed', { planId: PLAN_ID, files: ['a.ts'] });
    const delta = handlePlanBuildFilesChanged(event, state);
    expect(delta?.fileChanges?.get(OTHER)).toEqual(['x.ts']);
    expect(delta?.fileChanges?.get(PLAN_ID)).toEqual(['a.ts']);
  });

  // ---------------------------------------------------------------------------
  // plan:build:test:complete — productionIssues extraction
  // ---------------------------------------------------------------------------
  it('plan:build:test:complete extracts non-empty productionIssues into reviewIssues', () => {
    const productionIssues = [
      {
        severity: 'critical',
        category: 'production-bug',
        file: 'src/auth.ts',
        testFile: 'test/auth.test.ts',
        description: 'Token not validated',
      },
    ];
    const event = makeEvent('plan:build:test:complete', {
      planId: PLAN_ID,
      passed: 10,
      failed: 1,
      testBugsFixed: 0,
      productionIssues,
    });
    const delta = handlePlanBuildTestComplete(event, initialRunState);
    expect(delta?.reviewIssues?.[PLAN_ID]).toHaveLength(1);
    expect(delta?.reviewIssues?.[PLAN_ID]?.[0]).toMatchObject({
      severity: 'critical',
      category: 'production-bug',
      file: 'src/auth.ts',
      description: 'Token not validated',
    });
  });

  it('plan:build:test:complete returns undefined when productionIssues is empty', () => {
    const event = makeEvent('plan:build:test:complete', {
      planId: PLAN_ID,
      passed: 10,
      failed: 0,
      testBugsFixed: 0,
      productionIssues: [],
    });
    const delta = handlePlanBuildTestComplete(event, initialRunState);
    expect(delta).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // plan:merge:complete
  // ---------------------------------------------------------------------------
  it('plan:merge:complete → complete stage + mergeCommits captured', () => {
    const event = makeEvent('plan:merge:complete', { planId: PLAN_ID, commitSha: 'abc123' });
    const delta = handlePlanMergeComplete(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('complete');
    expect(delta?.mergeCommits?.[PLAN_ID]).toBe('abc123');
  });

  it('plan:merge:complete → complete stage without mergeCommits when commitSha absent', () => {
    const event = makeEvent('plan:merge:complete', { planId: PLAN_ID });
    const delta = handlePlanMergeComplete(event, initialRunState);
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('complete');
    expect(delta?.mergeCommits).toBeUndefined();
  });

  it('plan:merge:complete preserves other plan statuses', () => {
    const OTHER = 'plan-02';
    const state = { ...initialRunState, planStatuses: { [OTHER]: 'implement' as const } };
    const event = makeEvent('plan:merge:complete', { planId: PLAN_ID, commitSha: 'sha1' });
    const delta = handlePlanMergeComplete(event, state);
    expect(delta?.planStatuses?.[OTHER]).toBe('implement');
    expect(delta?.planStatuses?.[PLAN_ID]).toBe('complete');
  });
});
