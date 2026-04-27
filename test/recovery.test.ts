/**
 * Tests for the recovery-analyst engine core:
 *   - parseRecoveryVerdictBlock (parser round-trip, null on malformed)
 *   - recoveryVerdictSchema (Zod acceptance per verdict)
 *   - getRecoveryVerdictSchemaYaml (non-empty YAML with expected keys)
 *   - writeRecoverySidecar (.recovery.md + .recovery.json formatting)
 *   - buildFailureSummary (against fixture state + temp git repo)
 *   - runRecoveryAnalyst (agent wiring: events, tools:'none', parse/error paths)
 */

import { describe, it, expect } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { EforgeEvent, BuildFailureSummary } from '@eforge-build/engine/events';
import { parseRecoveryVerdictBlock } from '@eforge-build/engine/agents/common';
import { recoveryVerdictSchema, getRecoveryVerdictSchemaYaml } from '@eforge-build/engine/schemas';
import { runRecoveryAnalyst } from '@eforge-build/engine/agents/recovery-analyst';
import { writeRecoverySidecar } from '@eforge-build/engine/recovery/sidecar';
import { buildFailureSummary } from '@eforge-build/engine/recovery/failure-summary';
import { EforgeEngine } from '@eforge-build/engine/eforge';
import { StubHarness } from './stub-harness.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { useTempDir } from './test-tmpdir.js';

// ---------------------------------------------------------------------------
// parseRecoveryVerdictBlock
// ---------------------------------------------------------------------------

describe('parseRecoveryVerdictBlock', () => {
  it('returns null for empty text', () => {
    expect(parseRecoveryVerdictBlock('')).toBeNull();
  });

  it('returns null for plain text with no XML block', () => {
    expect(parseRecoveryVerdictBlock('I recommend manual review.')).toBeNull();
  });

  it('returns null when verdict attribute is invalid', () => {
    const text = `<recovery verdict="unknown" confidence="high">
  <rationale>Some reason</rationale>
  <completedWork></completedWork>
  <remainingWork></remainingWork>
  <risks></risks>
</recovery>`;
    expect(parseRecoveryVerdictBlock(text)).toBeNull();
  });

  it('returns null when confidence attribute is invalid', () => {
    const text = `<recovery verdict="retry" confidence="extreme">
  <rationale>Some reason</rationale>
  <completedWork></completedWork>
  <remainingWork></remainingWork>
  <risks></risks>
</recovery>`;
    expect(parseRecoveryVerdictBlock(text)).toBeNull();
  });

  it('returns null when rationale is missing', () => {
    const text = `<recovery verdict="manual" confidence="low">
  <completedWork></completedWork>
  <remainingWork></remainingWork>
  <risks></risks>
</recovery>`;
    expect(parseRecoveryVerdictBlock(text)).toBeNull();
  });

  it('parses retry verdict', () => {
    const text = `<recovery verdict="retry" confidence="high">
  <rationale>The failure was a transient network timeout — no code issues.</rationale>
  <completedWork>
    <item>plan-01: merged successfully</item>
  </completedWork>
  <remainingWork>
    <item>plan-02: timed out, retry should succeed</item>
  </remainingWork>
  <risks>
    <item>Network instability may persist</item>
  </risks>
</recovery>`;
    const result = parseRecoveryVerdictBlock(text);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('retry');
    expect(result!.confidence).toBe('high');
    expect(result!.rationale).toBe('The failure was a transient network timeout — no code issues.');
    expect(result!.completedWork).toEqual(['plan-01: merged successfully']);
    expect(result!.remainingWork).toEqual(['plan-02: timed out, retry should succeed']);
    expect(result!.risks).toEqual(['Network instability may persist']);
    expect(result!.suggestedSuccessorPrd).toBeUndefined();
  });

  it('parses split verdict with suggestedSuccessorPrd', () => {
    const text = `<recovery verdict="split" confidence="medium">
  <rationale>Foundation work is preserved; API work remains incomplete.</rationale>
  <completedWork>
    <item>Database schema merged</item>
    <item>Auth middleware merged</item>
  </completedWork>
  <remainingWork>
    <item>REST API endpoints</item>
    <item>Integration tests</item>
  </remainingWork>
  <risks>
    <item>Type error must be fixed</item>
  </risks>
  <suggestedSuccessorPrd># API Implementation\n\nBuild the REST layer.</suggestedSuccessorPrd>
</recovery>`;
    const result = parseRecoveryVerdictBlock(text);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('split');
    expect(result!.confidence).toBe('medium');
    expect(result!.completedWork).toHaveLength(2);
    expect(result!.remainingWork).toHaveLength(2);
    expect(result!.suggestedSuccessorPrd).toContain('API Implementation');
  });

  it('parses abandon verdict', () => {
    const text = `<recovery verdict="abandon" confidence="high">
  <rationale>The feature was shipped in a hotfix before this build ran.</rationale>
  <completedWork>
    <item>Feature already live via hotfix</item>
  </completedWork>
  <remainingWork></remainingWork>
  <risks></risks>
</recovery>`;
    const result = parseRecoveryVerdictBlock(text);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('abandon');
    expect(result!.completedWork).toHaveLength(1);
    expect(result!.remainingWork).toHaveLength(0);
  });

  it('parses manual verdict', () => {
    const text = `<recovery verdict="manual" confidence="low">
  <rationale>Insufficient evidence — ambiguous error with no clear transient indicator.</rationale>
  <completedWork></completedWork>
  <remainingWork>
    <item>All acceptance criteria remain</item>
  </remainingWork>
  <risks>
    <item>Unknown root cause</item>
  </risks>
</recovery>`;
    const result = parseRecoveryVerdictBlock(text);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('manual');
    expect(result!.confidence).toBe('low');
    expect(result!.remainingWork).toHaveLength(1);
  });

  it('extracts the block from surrounding text', () => {
    const text = `Analysis complete. Based on my review:

<recovery verdict="manual" confidence="low">
  <rationale>Evidence is unclear.</rationale>
  <completedWork></completedWork>
  <remainingWork></remainingWork>
  <risks></risks>
</recovery>

That concludes my assessment.`;
    const result = parseRecoveryVerdictBlock(text);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// recoveryVerdictSchema
// ---------------------------------------------------------------------------

describe('recoveryVerdictSchema', () => {
  function makeVerdict(overrides: Record<string, unknown> = {}) {
    return {
      verdict: 'manual',
      confidence: 'low',
      rationale: 'Insufficient evidence',
      completedWork: [],
      remainingWork: [],
      risks: [],
      ...overrides,
    };
  }

  it('accepts retry verdict', () => {
    expect(recoveryVerdictSchema.safeParse(makeVerdict({ verdict: 'retry', confidence: 'high' })).success).toBe(true);
  });

  it('accepts split verdict with suggestedSuccessorPrd', () => {
    const result = recoveryVerdictSchema.safeParse(makeVerdict({
      verdict: 'split',
      confidence: 'medium',
      suggestedSuccessorPrd: '# Successor PRD\n\nContent here.',
    }));
    expect(result.success).toBe(true);
  });

  it('accepts abandon verdict', () => {
    expect(recoveryVerdictSchema.safeParse(makeVerdict({ verdict: 'abandon' })).success).toBe(true);
  });

  it('accepts manual verdict (no suggestedSuccessorPrd)', () => {
    expect(recoveryVerdictSchema.safeParse(makeVerdict()).success).toBe(true);
  });

  it('rejects unknown verdict', () => {
    expect(recoveryVerdictSchema.safeParse(makeVerdict({ verdict: 'unknown' })).success).toBe(false);
  });

  it('rejects unknown confidence', () => {
    expect(recoveryVerdictSchema.safeParse(makeVerdict({ confidence: 'extreme' })).success).toBe(false);
  });

  it('rejects empty rationale', () => {
    expect(recoveryVerdictSchema.safeParse(makeVerdict({ rationale: '' })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRecoveryVerdictSchemaYaml
// ---------------------------------------------------------------------------

describe('getRecoveryVerdictSchemaYaml', () => {
  it('returns non-empty YAML', () => {
    const yaml = getRecoveryVerdictSchemaYaml();
    expect(yaml.length).toBeGreaterThan(0);
  });

  it('contains the literal string "verdict"', () => {
    expect(getRecoveryVerdictSchemaYaml()).toContain('verdict');
  });

  it('contains "manual" in an enum array', () => {
    expect(getRecoveryVerdictSchemaYaml()).toContain('manual');
  });

  it('contains all four verdict values', () => {
    const yaml = getRecoveryVerdictSchemaYaml();
    expect(yaml).toContain('retry');
    expect(yaml).toContain('split');
    expect(yaml).toContain('abandon');
    expect(yaml).toContain('manual');
  });

  it('is cached — returns the same string on repeated calls', () => {
    expect(getRecoveryVerdictSchemaYaml()).toBe(getRecoveryVerdictSchemaYaml());
  });
});

// ---------------------------------------------------------------------------
// writeRecoverySidecar
// ---------------------------------------------------------------------------

describe('writeRecoverySidecar', () => {
  const makeTempDir = useTempDir('eforge-recovery-sidecar-test-');

  function makeSummary(): BuildFailureSummary {
    return {
      prdId: 'test-prd',
      setName: 'test-set',
      featureBranch: 'eforge/test-set',
      baseBranch: 'main',
      plans: [
        { planId: 'plan-01', status: 'merged' },
        { planId: 'plan-02', status: 'failed', error: 'Type error' },
      ],
      failingPlan: { planId: 'plan-02', errorMessage: 'Type error' },
      landedCommits: [
        { sha: 'abc123def456', subject: 'feat: foundation', author: 'Dev', date: '2024-01-15' },
      ],
      diffStat: '3 files changed, 42 insertions(+)',
      modelsUsed: ['claude-sonnet-4-6'],
      failedAt: '2024-01-15T10:45:00.000Z',
    };
  }

  function makeVerdict(verdict: string = 'split'): ReturnType<typeof parseRecoveryVerdictBlock> {
    return {
      verdict: verdict as 'retry' | 'split' | 'abandon' | 'manual',
      confidence: 'medium',
      rationale: 'Foundation work preserved; API work remains.',
      completedWork: ['Foundation merged'],
      remainingWork: ['API endpoints'],
      risks: ['Type error unresolved'],
      suggestedSuccessorPrd: verdict === 'split' ? '# Successor PRD' : undefined,
    };
  }

  it('produces both .recovery.md and .recovery.json files', async () => {
    const dir = makeTempDir();
    const { mdPath, jsonPath } = await writeRecoverySidecar({
      failedPrdDir: dir,
      prdId: 'test-prd',
      summary: makeSummary(),
      verdict: makeVerdict()!,
    });

    const md = await readFile(mdPath, 'utf-8');
    const json = await readFile(jsonPath, 'utf-8');

    expect(md.length).toBeGreaterThan(0);
    expect(json.length).toBeGreaterThan(0);
  });

  it('JSON includes schemaVersion: 2, summary, verdict, generatedAt', async () => {
    const dir = makeTempDir();
    const { jsonPath } = await writeRecoverySidecar({
      failedPrdDir: dir,
      prdId: 'test-prd',
      summary: makeSummary(),
      verdict: makeVerdict()!,
    });

    const raw = await readFile(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.prdId).toBe('test-prd');
    expect(parsed.verdict).toBeDefined();
    expect(parsed.verdict.verdict).toBe('split');
    expect(parsed.generatedAt).toBeDefined();
    expect(typeof parsed.generatedAt).toBe('string');
  });

  it('markdown includes verdict, plan table, and landed commits', async () => {
    const dir = makeTempDir();
    const { mdPath } = await writeRecoverySidecar({
      failedPrdDir: dir,
      prdId: 'test-prd',
      summary: makeSummary(),
      verdict: makeVerdict()!,
    });

    const md = await readFile(mdPath, 'utf-8');
    expect(md).toContain('SPLIT');
    expect(md).toContain('plan-01');
    expect(md).toContain('plan-02');
    expect(md).toContain('feat: foundation');
    expect(md).toContain('abc123de'); // short SHA
  });

  it('markdown includes suggestedSuccessorPrd for split verdict', async () => {
    const dir = makeTempDir();
    const { mdPath } = await writeRecoverySidecar({
      failedPrdDir: dir,
      prdId: 'test-prd',
      summary: makeSummary(),
      verdict: makeVerdict('split')!,
    });

    const md = await readFile(mdPath, 'utf-8');
    expect(md).toContain('Successor PRD');
  });

  it('creates the target directory if it does not exist', async () => {
    const baseDir = makeTempDir();
    const nestedDir = join(baseDir, 'deep', 'nested', 'dir');

    const { jsonPath } = await writeRecoverySidecar({
      failedPrdDir: nestedDir,
      prdId: 'nested-prd',
      summary: makeSummary(),
      verdict: makeVerdict('manual')!,
    });

    const raw = await readFile(jsonPath, 'utf-8');
    expect(JSON.parse(raw).schemaVersion).toBe(2);
  });

  it('produces valid JSON for each verdict type', async () => {
    const dir = makeTempDir();
    for (const verdict of ['retry', 'split', 'abandon', 'manual'] as const) {
      const subDir = join(dir, verdict);
      const { jsonPath } = await writeRecoverySidecar({
        failedPrdDir: subDir,
        prdId: `prd-${verdict}`,
        summary: makeSummary(),
        verdict: makeVerdict(verdict)!,
      });
      const parsed = JSON.parse(await readFile(jsonPath, 'utf-8'));
      expect(parsed.verdict.verdict).toBe(verdict);
      expect(parsed.schemaVersion).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// buildFailureSummary
// ---------------------------------------------------------------------------

describe('buildFailureSummary', () => {
  const makeTempDir = useTempDir('eforge-recovery-summary-test-');

  /**
   * Set up a temp git repository with:
   * - 1 commit on `main`
   * - 2 commits on `eforge/test-recovery-set` with a Models-Used: trailer
   */
  function seedGitRepo(dir: string): void {
    const gitOpts = { cwd: dir };
    execFileSync('git', ['init', '-b', 'main'], gitOpts);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], gitOpts);
    execFileSync('git', ['config', 'user.name', 'Test'], gitOpts);

    // Initial commit on main
    execFileSync('git', ['commit', '--allow-empty', '-m', 'chore: initial commit'], gitOpts);

    // Feature branch with 2 commits
    execFileSync('git', ['checkout', '-b', 'eforge/test-recovery-set'], gitOpts);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: plan-01 foundation\n\nModels-Used: claude-sonnet-4-6\n\nCo-Authored-By: forged-by-eforge <noreply@eforge.build>'], gitOpts);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'wip: plan-02 api partial'], gitOpts);

    // Return to main (repo stays at main HEAD)
    execFileSync('git', ['checkout', 'main'], gitOpts);
  }

  it('returns correct failingPlan.planId from state.json', async () => {
    const dir = makeTempDir();
    seedGitRepo(dir);

    // Write state.json
    await mkdir(join(dir, '.eforge'), { recursive: true });
    const stateFixture = await readFile(
      new URL('./fixtures/recovery/state.json', import.meta.url).pathname,
      'utf-8',
    );
    await writeFile(join(dir, '.eforge', 'state.json'), stateFixture, 'utf-8');

    const summary = await buildFailureSummary({
      setName: 'test-recovery-set',
      prdId: 'test-prd',
      cwd: dir,
    });

    expect(summary.failingPlan.planId).toBe('plan-02-api');
    expect(summary.failingPlan.errorMessage).toContain('type error');
  });

  it('returns landedCommits with length matching commits on feature branch', async () => {
    const dir = makeTempDir();
    seedGitRepo(dir);

    await mkdir(join(dir, '.eforge'), { recursive: true });
    const stateFixture = await readFile(
      new URL('./fixtures/recovery/state.json', import.meta.url).pathname,
      'utf-8',
    );
    await writeFile(join(dir, '.eforge', 'state.json'), stateFixture, 'utf-8');

    const summary = await buildFailureSummary({
      setName: 'test-recovery-set',
      prdId: 'test-prd',
      cwd: dir,
    });

    // The feature branch has 2 commits beyond main
    expect(summary.landedCommits).toHaveLength(2);
    expect(summary.landedCommits[0].sha.length).toBe(40);
    expect(summary.landedCommits[0].subject.length).toBeGreaterThan(0);
  });

  it('parses modelsUsed from commit trailers', async () => {
    const dir = makeTempDir();
    seedGitRepo(dir);

    await mkdir(join(dir, '.eforge'), { recursive: true });
    const stateFixture = await readFile(
      new URL('./fixtures/recovery/state.json', import.meta.url).pathname,
      'utf-8',
    );
    await writeFile(join(dir, '.eforge', 'state.json'), stateFixture, 'utf-8');

    const summary = await buildFailureSummary({
      setName: 'test-recovery-set',
      prdId: 'test-prd',
      cwd: dir,
    });

    expect(summary.modelsUsed).toContain('claude-sonnet-4-6');
  });

  it('returns setName, baseBranch, featureBranch from state', async () => {
    const dir = makeTempDir();
    seedGitRepo(dir);

    await mkdir(join(dir, '.eforge'), { recursive: true });
    const stateFixture = await readFile(
      new URL('./fixtures/recovery/state.json', import.meta.url).pathname,
      'utf-8',
    );
    await writeFile(join(dir, '.eforge', 'state.json'), stateFixture, 'utf-8');

    const summary = await buildFailureSummary({
      setName: 'test-recovery-set',
      prdId: 'test-prd',
      cwd: dir,
    });

    expect(summary.setName).toBe('test-recovery-set');
    expect(summary.baseBranch).toBe('main');
    expect(summary.featureBranch).toBe('eforge/test-recovery-set');
    expect(summary.prdId).toBe('test-prd');
  });

  it('returns partial summary when state.json is missing', async () => {
    const dir = makeTempDir();
    const summary = await buildFailureSummary({ setName: 'x', prdId: 'y', cwd: dir });
    expect(summary.partial).toBe(true);
    expect(summary.prdId).toBe('y');
    expect(summary.setName).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// runRecoveryAnalyst (agent wiring)
// ---------------------------------------------------------------------------

describe('runRecoveryAnalyst wiring', () => {
  const makeTempDir = useTempDir('eforge-recovery-analyst-test-');

  function makeSummary(): BuildFailureSummary {
    return {
      prdId: 'test-prd',
      setName: 'test-set',
      featureBranch: 'eforge/test-set',
      baseBranch: 'main',
      plans: [{ planId: 'plan-01', status: 'failed', error: 'Timeout' }],
      failingPlan: { planId: 'plan-01', errorMessage: 'Timeout' },
      landedCommits: [],
      diffStat: '',
      modelsUsed: [],
      failedAt: '2024-01-15T10:00:00.000Z',
    };
  }

  const SPLIT_OUTPUT = `Based on my analysis of the failure:

<recovery verdict="split" confidence="medium">
  <rationale>Foundation work is preserved; API work remains incomplete due to the timeout.</rationale>
  <completedWork>
    <item>Database schema merged</item>
  </completedWork>
  <remainingWork>
    <item>API endpoints not implemented</item>
  </remainingWork>
  <risks>
    <item>Timeout root cause unknown</item>
  </risks>
  <suggestedSuccessorPrd># Successor PRD\n\nContinue the API work.</suggestedSuccessorPrd>
</recovery>`;

  it('emits recovery:summary then recovery:complete for valid agent output', async () => {
    const backend = new StubHarness([{ text: SPLIT_OUTPUT }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runRecoveryAnalyst({
      harness: backend,
      prdId: 'test-prd',
      prdContent: '# PRD\n\nBuild a thing.',
      summary: makeSummary(),
      cwd,
    }));

    const summary = findEvent(events, 'recovery:summary');
    expect(summary).toBeDefined();
    expect(summary!.prdId).toBe('test-prd');
    expect(summary!.summary.setName).toBe('test-set');

    const complete = findEvent(events, 'recovery:complete');
    expect(complete).toBeDefined();
    expect(complete!.verdict.verdict).toBe('split');
    expect(complete!.verdict.confidence).toBe('medium');
    expect(complete!.prdId).toBe('test-prd');

    // No error event
    expect(findEvent(events, 'recovery:error')).toBeUndefined();
  });

  it('emits recovery:error when agent output has no valid block', async () => {
    const backend = new StubHarness([{ text: 'I am unable to determine the recovery path.' }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runRecoveryAnalyst({
      harness: backend,
      prdId: 'test-prd',
      prdContent: '# PRD',
      summary: makeSummary(),
      cwd,
    }));

    const error = findEvent(events, 'recovery:error');
    expect(error).toBeDefined();
    expect(error!.prdId).toBe('test-prd');
    expect(error!.error).toContain('parse');

    // No complete event
    expect(findEvent(events, 'recovery:complete')).toBeUndefined();
    expect(findEvent(events, 'recovery:summary')).toBeUndefined();
  });

  it('invokes harness with tools: "none"', async () => {
    const backend = new StubHarness([{ text: SPLIT_OUTPUT }]);
    const cwd = makeTempDir();

    await collectEvents(runRecoveryAnalyst({
      harness: backend,
      prdId: 'test-prd',
      prdContent: '# PRD',
      summary: makeSummary(),
      cwd,
    }));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].tools).toBe('none');
  });

  it('suppresses agent:message when verbose is false (default)', async () => {
    const backend = new StubHarness([{ text: SPLIT_OUTPUT }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runRecoveryAnalyst({
      harness: backend,
      prdId: 'test-prd',
      prdContent: '# PRD',
      summary: makeSummary(),
      cwd,
    }));

    expect(filterEvents(events, 'agent:message')).toHaveLength(0);
  });

  it('emits agent:message when verbose is true', async () => {
    const backend = new StubHarness([{ text: SPLIT_OUTPUT }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runRecoveryAnalyst({
      harness: backend,
      prdId: 'test-prd',
      prdContent: '# PRD',
      summary: makeSummary(),
      cwd,
      verbose: true,
    }));

    expect(filterEvents(events, 'agent:message').length).toBeGreaterThan(0);
  });

  it('always emits agent:result', async () => {
    const backend = new StubHarness([{ text: SPLIT_OUTPUT }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runRecoveryAnalyst({
      harness: backend,
      prdId: 'test-prd',
      prdContent: '# PRD',
      summary: makeSummary(),
      cwd,
    }));

    expect(findEvent(events, 'agent:result')).toBeDefined();
  });

  it('prompt includes prdContent, summary JSON, and schema YAML', async () => {
    const backend = new StubHarness([{ text: SPLIT_OUTPUT }]);
    const cwd = makeTempDir();

    await collectEvents(runRecoveryAnalyst({
      harness: backend,
      prdId: 'test-prd',
      prdContent: '# My PRD\n\nDo a thing.',
      summary: makeSummary(),
      cwd,
    }));

    const prompt = backend.prompts[0];
    expect(prompt).toContain('# My PRD');
    expect(prompt).toContain('test-set'); // from summary JSON
    expect(prompt).toContain('verdict'); // from schema YAML
  });

  it('parses retry verdict correctly', async () => {
    const retryOutput = `<recovery verdict="retry" confidence="high">
  <rationale>Network timeout — transient failure.</rationale>
  <completedWork></completedWork>
  <remainingWork><item>All work remains</item></remainingWork>
  <risks><item>Network may timeout again</item></risks>
</recovery>`;
    const backend = new StubHarness([{ text: retryOutput }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runRecoveryAnalyst({
      harness: backend,
      prdId: 'test-prd',
      prdContent: '# PRD',
      summary: makeSummary(),
      cwd,
    }));

    const complete = findEvent(events, 'recovery:complete');
    expect(complete).toBeDefined();
    expect(complete!.verdict.verdict).toBe('retry');
  });

  it('parses abandon verdict correctly', async () => {
    const abandonOutput = `<recovery verdict="abandon" confidence="high">
  <rationale>Already shipped via hotfix.</rationale>
  <completedWork><item>Shipped via hotfix</item></completedWork>
  <remainingWork></remainingWork>
  <risks></risks>
</recovery>`;
    const backend = new StubHarness([{ text: abandonOutput }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runRecoveryAnalyst({
      harness: backend,
      prdId: 'test-prd',
      prdContent: '# PRD',
      summary: makeSummary(),
      cwd,
    }));

    const complete = findEvent(events, 'recovery:complete');
    expect(complete!.verdict.verdict).toBe('abandon');
  });

  it('parses manual verdict correctly', async () => {
    const manualOutput = `<recovery verdict="manual" confidence="low">
  <rationale>Ambiguous error with no clear cause.</rationale>
  <completedWork></completedWork>
  <remainingWork><item>All work remains</item></remainingWork>
  <risks><item>Unknown root cause</item></risks>
</recovery>`;
    const backend = new StubHarness([{ text: manualOutput }]);
    const cwd = makeTempDir();

    const events = await collectEvents(runRecoveryAnalyst({
      harness: backend,
      prdId: 'test-prd',
      prdContent: '# PRD',
      summary: makeSummary(),
      cwd,
    }));

    const complete = findEvent(events, 'recovery:complete');
    expect(complete!.verdict.verdict).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// EforgeEngine.recover (integration)
// ---------------------------------------------------------------------------

describe('EforgeEngine.recover', () => {
  const makeTempDir = useTempDir('eforge-engine-recover-test-');

  function seedGitRepo(dir: string): void {
    const gitOpts = { cwd: dir };
    execFileSync('git', ['init', '-b', 'main'], gitOpts);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], gitOpts);
    execFileSync('git', ['config', 'user.name', 'Test'], gitOpts);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'chore: initial commit'], gitOpts);
    execFileSync('git', ['checkout', '-b', 'eforge/test-recovery-set'], gitOpts);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: plan-01 foundation'], gitOpts);
    execFileSync('git', ['checkout', 'main'], gitOpts);
  }

  async function seedFixtures(dir: string): Promise<void> {
    // Write state.json
    await mkdir(join(dir, '.eforge'), { recursive: true });
    const stateFixture = await readFile(
      new URL('./fixtures/recovery/state.json', import.meta.url).pathname,
      'utf-8',
    );
    await writeFile(join(dir, '.eforge', 'state.json'), stateFixture, 'utf-8');

    // Write PRD file in failed dir
    const failedDir = join(dir, 'eforge', 'queue', 'failed');
    await mkdir(failedDir, { recursive: true });
    await writeFile(join(failedDir, 'test-prd.md'), '# Test PRD\n\nBuild a thing.', 'utf-8');
  }

  const SPLIT_OUTPUT = `Based on my analysis:

<recovery verdict="split" confidence="medium">
  <rationale>Foundation work is preserved; API work remains incomplete.</rationale>
  <completedWork>
    <item>Foundation merged</item>
  </completedWork>
  <remainingWork>
    <item>API endpoints not implemented</item>
  </remainingWork>
  <risks>
    <item>Type error unresolved</item>
  </risks>
  <suggestedSuccessorPrd># Successor PRD\n\nContinue the API work.</suggestedSuccessorPrd>
</recovery>`;

  it('writes degraded sidecar when PRD file does not exist (no throw)', async () => {
    const dir = makeTempDir();
    seedGitRepo(dir);
    await mkdir(join(dir, '.eforge'), { recursive: true });
    const stateFixture = await readFile(
      new URL('./fixtures/recovery/state.json', import.meta.url).pathname,
      'utf-8',
    );
    await writeFile(join(dir, '.eforge', 'state.json'), stateFixture, 'utf-8');
    // PRD file intentionally absent

    const backend = new StubHarness([{ text: SPLIT_OUTPUT }]);
    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: backend });

    // Should NOT throw — degraded sidecar with partial:true is written instead
    const events = await collectEvents(engine.recover('test-recovery-set', 'test-prd'));

    const complete = findEvent(events, 'recovery:complete');
    expect(complete).toBeDefined();
    expect(complete!.verdict.verdict).toBe('manual');
    expect(complete!.verdict.partial).toBe(true);
    expect(complete!.verdict.recoveryError).toContain('not found');
  });

  it('writes both sidecar files for a split verdict', async () => {
    const dir = makeTempDir();
    seedGitRepo(dir);
    await seedFixtures(dir);

    const backend = new StubHarness([{ text: SPLIT_OUTPUT }]);
    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: backend });

    const events = await collectEvents(engine.recover('test-recovery-set', 'test-prd'));

    const complete = findEvent(events, 'recovery:complete');
    expect(complete).toBeDefined();
    expect(complete!.sidecarMdPath).toBeDefined();
    expect(complete!.sidecarJsonPath).toBeDefined();

    // Both files must exist and be well-formed
    const mdContent = await readFile(complete!.sidecarMdPath!, 'utf-8');
    expect(mdContent.length).toBeGreaterThan(0);

    const parsed = JSON.parse(await readFile(complete!.sidecarJsonPath!, 'utf-8'));
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.verdict.verdict).toBe('split');
  });

  it('produces a manual verdict sidecar on parse failure (no throw)', async () => {
    const dir = makeTempDir();
    seedGitRepo(dir);
    await seedFixtures(dir);

    const backend = new StubHarness([{ text: 'I cannot determine the recovery path.' }]);
    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: backend });

    // Should NOT throw — parse failure yields a manual verdict sidecar
    const events = await collectEvents(engine.recover('test-recovery-set', 'test-prd'));

    const complete = findEvent(events, 'recovery:complete');
    expect(complete).toBeDefined();
    expect(complete!.verdict.verdict).toBe('manual');
    expect(complete!.sidecarMdPath).toBeDefined();
    expect(complete!.sidecarJsonPath).toBeDefined();

    await expect(readFile(complete!.sidecarMdPath!, 'utf-8')).resolves.toBeTruthy();
    const json = JSON.parse(await readFile(complete!.sidecarJsonPath!, 'utf-8'));
    expect(json.verdict.verdict).toBe('manual');
    expect(json.schemaVersion).toBe(2);
  });

  it.each(['retry', 'split', 'abandon', 'manual'] as const)('writes sidecars for %s verdict', async (verdict) => {
    const dir = makeTempDir();
    seedGitRepo(dir);
    await seedFixtures(dir);

    let verdictOutput: string;
    if (verdict === 'split') {
      verdictOutput = SPLIT_OUTPUT;
    } else if (verdict === 'retry') {
      verdictOutput = `<recovery verdict="retry" confidence="high">
  <rationale>Network timeout — transient failure.</rationale>
  <completedWork></completedWork>
  <remainingWork><item>All work remains</item></remainingWork>
  <risks><item>Network may timeout again</item></risks>
</recovery>`;
    } else if (verdict === 'abandon') {
      verdictOutput = `<recovery verdict="abandon" confidence="high">
  <rationale>Already shipped via hotfix.</rationale>
  <completedWork><item>Shipped via hotfix</item></completedWork>
  <remainingWork></remainingWork>
  <risks></risks>
</recovery>`;
    } else {
      verdictOutput = `<recovery verdict="manual" confidence="low">
  <rationale>Ambiguous error with no clear cause.</rationale>
  <completedWork></completedWork>
  <remainingWork><item>All work remains</item></remainingWork>
  <risks><item>Unknown root cause</item></risks>
</recovery>`;
    }

    const backend = new StubHarness([{ text: verdictOutput }]);
    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: backend });

    const events = await collectEvents(engine.recover('test-recovery-set', 'test-prd'));

    const complete = findEvent(events, 'recovery:complete');
    expect(complete).toBeDefined();
    expect(complete!.verdict.verdict).toBe(verdict);
    expect(complete!.sidecarMdPath).toBeDefined();
    expect(complete!.sidecarJsonPath).toBeDefined();

    const json = JSON.parse(await readFile(complete!.sidecarJsonPath!, 'utf-8'));
    expect(json.schemaVersion).toBe(2);
    expect(json.verdict.verdict).toBe(verdict);
  });

  it('emits recovery:start before recovery:complete', async () => {
    const dir = makeTempDir();
    seedGitRepo(dir);
    await seedFixtures(dir);

    const backend = new StubHarness([{ text: SPLIT_OUTPUT }]);
    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: backend });

    const events = await collectEvents(engine.recover('test-recovery-set', 'test-prd'));

    const start = findEvent(events, 'recovery:start');
    expect(start).toBeDefined();
    expect(start!.prdId).toBe('test-prd');
    expect(start!.setName).toBe('test-recovery-set');

    const complete = findEvent(events, 'recovery:complete');
    expect(complete).toBeDefined();

    const startIdx = events.indexOf(start!);
    const completeIdx = events.indexOf(complete!);
    expect(startIdx).toBeLessThan(completeIdx);
  });

  it('does not modify files outside the two sidecar paths', async () => {
    const dir = makeTempDir();
    seedGitRepo(dir);
    await seedFixtures(dir);

    const failedDir = join(dir, 'eforge', 'queue', 'failed');
    const prdPath = join(failedDir, 'test-prd.md');

    const backend = new StubHarness([{ text: SPLIT_OUTPUT }]);
    const engine = await EforgeEngine.create({ cwd: dir, agentRuntimes: backend });

    // Capture PRD file content before
    const prdContentBefore = await readFile(prdPath, 'utf-8');

    await collectEvents(engine.recover('test-recovery-set', 'test-prd'));

    // PRD file unchanged
    const prdContentAfter = await readFile(prdPath, 'utf-8');
    expect(prdContentAfter).toBe(prdContentBefore);

    // state.json unchanged
    const stateAfter = await readFile(join(dir, '.eforge', 'state.json'), 'utf-8');
    expect(stateAfter).toContain('"status": "failed"');
  });
});
