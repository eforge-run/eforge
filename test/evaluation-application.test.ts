import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  EvaluationInvariantError,
  EvaluationValidationError,
  applyEvaluationVerdicts,
  cleanupEvaluationSnapshot,
  prepareEvaluationSnapshot,
  restoreEvaluationSnapshotAfterFailure,
  validateEvaluationVerdicts,
  type EvaluationSnapshot,
} from '@eforge-build/engine/evaluation';
import { ModelTracker } from '@eforge-build/engine/model-tracker';
import { useTempDir } from './test-tmpdir.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout;
}

async function initRepo(dir: string): Promise<string> {
  const repoRoot = join(dir, 'repo');
  await git(dir, ['init', '-b', 'main', repoRoot]);
  await git(repoRoot, ['config', 'user.email', 'test@eforge.build']);
  await git(repoRoot, ['config', 'user.name', 'eforge-test']);
  return repoRoot;
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', message]);
}

async function head(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

async function lastCommitMessage(cwd: string): Promise<string> {
  return (await git(cwd, ['log', '-1', '--format=%B'])).trim();
}

async function committedFile(cwd: string, path: string): Promise<string> {
  return git(cwd, ['show', `HEAD:${path}`]);
}

async function statusShort(cwd: string): Promise<string> {
  return git(cwd, ['status', '--short']);
}

async function expectTrackedDiffsToMatchSnapshot(snapshot: EvaluationSnapshot): Promise<void> {
  expect(await git(snapshot.cwd, ['diff', '--cached', '--binary', '--find-renames'])).toBe(snapshot.stagedPatch);
  expect(await git(snapshot.cwd, ['diff', '--binary', '--find-renames'])).toBe(snapshot.candidatePatch);
}

async function writeRepoFile(cwd: string, path: string, content: string): Promise<void> {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), content, 'utf8');
}

function numberedLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`);
}

describe('evaluation application core', () => {
  const makeTempDir = useTempDir('eforge-evaluation-application-');

  it('accepts one file-level fix and discards reject/review verdicts', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'accepted.txt', 'base accepted\n');
    await writeRepoFile(repo, 'rejected.txt', 'base rejected\n');
    await writeRepoFile(repo, 'review.txt', 'base review\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'accepted.txt', 'base accepted\nimplementation\n');
    await writeRepoFile(repo, 'rejected.txt', 'base rejected\nimplementation\n');
    await writeRepoFile(repo, 'review.txt', 'base review\nimplementation\n');
    await commitAll(repo, 'feat: implementation');

    await writeRepoFile(repo, 'accepted.txt', 'base accepted\nimplementation\nreview fix accepted\n');
    await writeRepoFile(repo, 'rejected.txt', 'base rejected\nimplementation\nreview fix rejected\n');
    await writeRepoFile(repo, 'review.txt', 'base review\nimplementation\nneeds human review\n');

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    const result = await applyEvaluationVerdicts(snapshot, [
      { file: 'accepted.txt', action: 'accept', reason: 'Correct improvement' },
      { file: 'rejected.txt', action: 'reject', reason: 'Incorrect improvement' },
      { file: 'review.txt', action: 'review', reason: 'Needs another human pass' },
    ], { commitMessage: 'feat(plan-test): apply evaluated fixes' });

    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(2);
    expect(result.review).toBe(1);
    expect(result.committed).toBe(true);
    expect(result.commitSha).toBe(await head(repo));
    expect(await statusShort(repo)).toBe('');
    expect(await committedFile(repo, 'accepted.txt')).toBe('base accepted\nimplementation\nreview fix accepted\n');
    expect(await committedFile(repo, 'rejected.txt')).toBe('base rejected\nimplementation\n');
    expect(await committedFile(repo, 'review.txt')).toBe('base review\nimplementation\n');
    expect(await readFile(join(repo, 'accepted.txt'), 'utf8')).toBe('base accepted\nimplementation\nreview fix accepted\n');
    expect(await readFile(join(repo, 'rejected.txt'), 'utf8')).toBe('base rejected\nimplementation\n');
    expect(await readFile(join(repo, 'review.txt'), 'utf8')).toBe('base review\nimplementation\n');
  });

  it('accepts hunk 1 and rejects hunk 2 in one file', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', `${numberedLines(20).join('\n')}\n`);
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    const implementation = numberedLines(20);
    implementation[0] = 'implementation line 1';
    await writeRepoFile(repo, 'src.txt', `${implementation.join('\n')}\n`);
    await commitAll(repo, 'feat: implementation');

    const reviewer = [...implementation];
    reviewer[4] = 'accepted reviewer line 5';
    reviewer[17] = 'rejected reviewer line 18';
    await writeRepoFile(repo, 'src.txt', `${reviewer.join('\n')}\n`);

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    expect(snapshot.files[0].hunks).toHaveLength(2);

    const result = await applyEvaluationVerdicts(snapshot, [
      { file: 'src.txt', hunk: 1, action: 'accept', reason: 'First hunk is correct' },
      { file: 'src.txt', hunk: 2, action: 'reject', reason: 'Second hunk is wrong' },
    ], { commitMessage: 'feat(plan-test): apply evaluated hunks' });

    expect(result.committed).toBe(true);
    expect(result.commitSha).toBe(await head(repo));
    expect(await statusShort(repo)).toBe('');
    const committedContent = await committedFile(repo, 'src.txt');
    expect(committedContent).toContain('accepted reviewer line 5');
    expect(committedContent).not.toContain('rejected reviewer line 18');
    expect(committedContent).toContain('line 18');
    expect(await readFile(join(repo, 'src.txt'), 'utf8')).toBe(committedContent);
  });

  it('rejects unsafe verdict paths before creating a commit', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    await expect(applyEvaluationVerdicts(snapshot, [
      { file: '../outside.ts', action: 'accept', reason: 'Unsafe' },
    ], { commitMessage: 'feat(plan-test): should not commit' })).rejects.toThrow(EvaluationValidationError);
    expect(await head(repo)).toBe(resetTarget);
    await expectTrackedDiffsToMatchSnapshot(snapshot);

    await expect(applyEvaluationVerdicts(snapshot, [
      { file: '/tmp/outside.ts', action: 'accept', reason: 'Unsafe' },
    ], { commitMessage: 'feat(plan-test): should not commit' })).rejects.toThrow(EvaluationValidationError);
    expect(await head(repo)).toBe(resetTarget);
    await expectTrackedDiffsToMatchSnapshot(snapshot);
  });

  it('rejects hunk references outside the captured range before creating a commit', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', `${numberedLines(20).join('\n')}\n`);
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    const implementation = numberedLines(20);
    implementation[0] = 'implementation line 1';
    await writeRepoFile(repo, 'src.txt', `${implementation.join('\n')}\n`);
    await commitAll(repo, 'feat: implementation');

    const reviewer = [...implementation];
    reviewer[4] = 'reviewer line 5';
    reviewer[17] = 'reviewer line 18';
    await writeRepoFile(repo, 'src.txt', `${reviewer.join('\n')}\n`);

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    expect(snapshot.files[0].hunks).toHaveLength(2);

    await expect(applyEvaluationVerdicts(snapshot, [
      { file: 'src.txt', hunk: 1, action: 'accept', reason: 'ok' },
      { file: 'src.txt', hunk: 2, action: 'reject', reason: 'no' },
      { file: 'src.txt', hunk: 3, action: 'reject', reason: 'out of range' },
    ], { commitMessage: 'feat(plan-test): should not commit' })).rejects.toThrow(EvaluationValidationError);
    expect(await head(repo)).toBe(resetTarget);
    await expectTrackedDiffsToMatchSnapshot(snapshot);
  });

  it('rejects unknown, duplicate, and missing verdict coverage', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'one.txt', 'base one\n');
    await writeRepoFile(repo, 'two.txt', 'base two\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'one.txt', 'implementation one\n');
    await writeRepoFile(repo, 'two.txt', 'implementation two\n');
    await commitAll(repo, 'feat: implementation');
    await writeRepoFile(repo, 'one.txt', 'implementation one\nreview one\n');
    await writeRepoFile(repo, 'two.txt', 'implementation two\nreview two\n');

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);

    expect(() => validateEvaluationVerdicts(snapshot, [
      { file: 'one.txt', action: 'accept', reason: 'ok' },
      { file: 'two.txt', action: 'reject', reason: 'no' },
      { file: 'missing.txt', action: 'reject', reason: 'unknown' },
    ])).toThrow(EvaluationValidationError);

    expect(() => validateEvaluationVerdicts(snapshot, [
      { file: 'one.txt', action: 'accept', reason: 'ok' },
      { file: 'one.txt', action: 'reject', reason: 'duplicate' },
      { file: 'two.txt', action: 'reject', reason: 'no' },
    ])).toThrow(EvaluationValidationError);

    expect(() => validateEvaluationVerdicts(snapshot, [
      { file: 'one.txt', action: 'accept', reason: 'ok' },
    ])).toThrow(EvaluationValidationError);
    expect(await head(repo)).toBe(resetTarget);
  });

  it('requires file-level verdicts for untracked candidates', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    await writeRepoFile(repo, 'notes/untracked.txt', 'review-created file\n');

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    expect(snapshot.files.find(file => file.path === 'notes/untracked.txt')?.requiresFileVerdict).toBe(true);

    await expect(applyEvaluationVerdicts(snapshot, [
      { file: 'notes/untracked.txt', hunk: 1, action: 'accept', reason: 'Cannot hunk-accept untracked file' },
    ], { commitMessage: 'feat(plan-test): should not commit' })).rejects.toThrow(EvaluationValidationError);
    expect(await head(repo)).toBe(resetTarget);
    await expectTrackedDiffsToMatchSnapshot(snapshot);

    await applyEvaluationVerdicts(snapshot, [
      { file: 'notes/untracked.txt', action: 'reject', reason: 'Do not add this file' },
    ], { commitMessage: 'feat(plan-test): reject untracked file' });
    await expect(readFile(join(repo, 'notes/untracked.txt'), 'utf8')).rejects.toThrow();
  });

  it('requires file-level verdicts for binary and rename-only candidates', async () => {
    const repo = await initRepo(makeTempDir());
    await writeFile(join(repo, 'asset.bin'), Buffer.from([0, 1, 2]));
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeFile(join(repo, 'asset.bin'), Buffer.from([0, 1, 3]));
    await commitAll(repo, 'feat: implementation');
    await writeFile(join(repo, 'asset.bin'), Buffer.from([0, 1, 4]));

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    const binaryCandidate = snapshot.files.find(file => file.path === 'asset.bin');
    expect(binaryCandidate?.isBinary).toBe(true);
    expect(binaryCandidate?.requiresFileVerdict).toBe(true);

    await expect(applyEvaluationVerdicts(snapshot, [
      { file: 'asset.bin', hunk: 1, action: 'accept', reason: 'Binary files cannot be hunk-applied' },
    ], { commitMessage: 'feat(plan-test): should not commit' })).rejects.toThrow(/asset\.bin.*hunk 1/);
    expect(await head(repo)).toBe(resetTarget);
    await expectTrackedDiffsToMatchSnapshot(snapshot);

    await applyEvaluationVerdicts(snapshot, [
      { file: 'asset.bin', action: 'accept', reason: 'Accept binary fix as a whole file' },
    ], { commitMessage: 'feat(plan-test): accept binary fix' });
    expect(await readFile(join(repo, 'asset.bin'))).toEqual(Buffer.from([0, 1, 4]));

    const renameOnlySnapshot: EvaluationSnapshot = {
      cwd: repo,
      capturedAt: '2026-01-01T00:00:00.000Z',
      baseHead: resetTarget,
      stagedPatch: '',
      candidatePatch: '',
      files: [
        {
          path: 'new-name.txt',
          oldPath: 'old-name.txt',
          status: 'renamed',
          statusCode: 'R100',
          diff: 'diff --git a/old-name.txt b/new-name.txt\nsimilarity index 100%\nrename from old-name.txt\nrename to new-name.txt\n',
          diffHeader: 'diff --git a/old-name.txt b/new-name.txt\nsimilarity index 100%\nrename from old-name.txt\nrename to new-name.txt\n',
          hunks: [],
          isBinary: false,
          isUntracked: false,
          isRenameOnly: true,
          requiresFileVerdict: true,
        },
      ],
    };

    expect(() => validateEvaluationVerdicts(renameOnlySnapshot, [
      { file: 'new-name.txt', hunk: 1, action: 'reject', reason: 'Rename-only files cannot be hunk-applied' },
    ])).toThrow(/new-name\.txt.*hunk 1/);
    expect(validateEvaluationVerdicts(renameOnlySnapshot, [
      { file: 'new-name.txt', action: 'reject', reason: 'Reject the rename as a whole file' },
    ]).summary.fileLevel).toBe(1);
  });

  it('detects working-tree drift before creating a commit', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\ndrift\n');

    await expect(applyEvaluationVerdicts(snapshot, [
      { file: 'src.txt', action: 'accept', reason: 'Would otherwise be valid' },
    ], { commitMessage: 'feat(plan-test): should not commit' })).rejects.toThrow(EvaluationInvariantError);
    expect(await head(repo)).toBe(resetTarget);
    expect(await readFile(join(repo, 'src.txt'), 'utf8')).toBe('implementation\nreview\ndrift\n');
  });

  it('detects staged diff drift before creating a commit', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    await writeRepoFile(repo, 'extra-staged.txt', 'unexpected staged drift\n');
    await git(repo, ['add', 'extra-staged.txt']);

    await expect(applyEvaluationVerdicts(snapshot, [
      { file: 'src.txt', action: 'accept', reason: 'Would otherwise be valid' },
    ], { commitMessage: 'feat(plan-test): should not commit' })).rejects.toThrow(EvaluationInvariantError);
    expect(await head(repo)).toBe(resetTarget);
    expect(await readFile(join(repo, 'extra-staged.txt'), 'utf8')).toBe('unexpected staged drift\n');
  });

  it('detects untracked candidate content drift before creating a commit', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    await writeRepoFile(repo, 'notes/untracked.txt', 'review-created file\n');

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    await writeRepoFile(repo, 'notes/untracked.txt', 'mutated after snapshot\n');

    await expect(applyEvaluationVerdicts(snapshot, [
      { file: 'notes/untracked.txt', action: 'accept', reason: 'Would otherwise be valid' },
    ], { commitMessage: 'feat(plan-test): should not commit' })).rejects.toThrow(/notes\/untracked\.txt/);
    expect(await head(repo)).toBe(resetTarget);
    expect(await readFile(join(repo, 'notes/untracked.txt'), 'utf8')).toBe('mutated after snapshot\n');
  });

  it('cleans up candidate fixes while preserving the staged implementation diff', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');
    await writeRepoFile(repo, 'notes/untracked.txt', 'review-created file\n');

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    await cleanupEvaluationSnapshot(snapshot);

    expect(await git(repo, ['diff', '--cached', '--binary', '--find-renames'])).toBe(snapshot.stagedPatch);
    expect(await git(repo, ['diff', '--binary', '--find-renames'])).toBe('');
    expect(await readFile(join(repo, 'src.txt'), 'utf8')).toBe('implementation\n');
    await expect(readFile(join(repo, 'notes/untracked.txt'), 'utf8')).rejects.toThrow();
    expect(await head(repo)).toBe(resetTarget);
  });

  it('restores the captured staged and candidate diffs after non-fatal failure drift', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');
    await writeRepoFile(repo, 'notes/untracked.txt', 'review-created file\n');
    await writeFile(join(repo, 'empty-untracked.txt'), '', 'utf8');

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    await writeRepoFile(repo, 'src.txt', 'failure mutation\n');
    await git(repo, ['add', 'src.txt']);
    await writeRepoFile(repo, 'extra.txt', 'unexpected untracked file\n');

    await restoreEvaluationSnapshotAfterFailure(snapshot);

    expect(await git(repo, ['diff', '--cached', '--binary', '--find-renames'])).toBe(snapshot.stagedPatch);
    expect(await git(repo, ['diff', '--binary', '--find-renames'])).toBe(snapshot.candidatePatch);
    expect(await readFile(join(repo, 'src.txt'), 'utf8')).toBe('implementation\nreview\n');
    expect(await readFile(join(repo, 'notes/untracked.txt'), 'utf8')).toBe('review-created file\n');
    expect(await readFile(join(repo, 'empty-untracked.txt'), 'utf8')).toBe('');
    await expect(readFile(join(repo, 'extra.txt'), 'utf8')).rejects.toThrow();
    expect(await head(repo)).toBe(resetTarget);
  });

  it('creates forge commits with attribution and model trailers', async () => {
    const repo = await initRepo(makeTempDir());
    await writeRepoFile(repo, 'src.txt', 'base\n');
    await commitAll(repo, 'chore: initial');
    const resetTarget = await head(repo);

    await writeRepoFile(repo, 'src.txt', 'implementation\n');
    await commitAll(repo, 'feat: implementation');
    await writeRepoFile(repo, 'src.txt', 'implementation\nreview\n');

    const snapshot = await prepareEvaluationSnapshot(repo, resetTarget);
    const tracker = new ModelTracker();
    tracker.record('test-model-2');
    tracker.record('test-model-1');

    await applyEvaluationVerdicts(snapshot, [
      { file: 'src.txt', action: 'accept', reason: 'Correct' },
    ], { commitMessage: 'feat(plan-test): commit evaluated fix', modelTracker: tracker });

    const message = await lastCommitMessage(repo);
    expect(message).toContain('Models-Used: test-model-1, test-model-2');
    expect(message).toContain('Co-Authored-By: forged-by-eforge');
  });
});
