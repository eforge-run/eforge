import { describe, it, expect } from 'vitest';
import type { EvaluationSnapshot } from '@eforge-build/engine/evaluation';
import { createEvaluationTools } from '@eforge-build/engine/evaluation';

function makeSnapshot(): EvaluationSnapshot {
  return {
    cwd: '/tmp/repo',
    capturedAt: '2026-01-01T00:00:00.000Z',
    baseHead: 'base',
    stagedPatch: '',
    candidatePatch: 'diff --git a/src/foo.ts b/src/foo.ts\n',
    files: [
      {
        path: 'src/foo.ts',
        status: 'modified',
        statusCode: 'M',
        diff: 'diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n',
        diffHeader: 'diff --git a/src/foo.ts b/src/foo.ts\n',
        hunks: [
          {
            index: 1,
            header: '@@ -1 +1 @@',
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            diff: '@@ -1 +1 @@\n-old\n+new\n',
          },
        ],
        isBinary: false,
        isUntracked: false,
        isRenameOnly: false,
        requiresFileVerdict: false,
      },
    ],
  };
}

describe('evaluation custom tools', () => {
  it('lists captured files and returns immutable captured diffs', async () => {
    const snapshot = makeSnapshot();
    const tools = createEvaluationTools(snapshot, () => undefined);
    const listTool = tools.find(tool => tool.name === 'list_evaluation_files');
    const diffTool = tools.find(tool => tool.name === 'get_evaluation_diff');

    expect(listTool).toBeDefined();
    expect(diffTool).toBeDefined();

    const listed = JSON.parse(await listTool!.handler({})) as {
      files: Array<{ file: string; hunkCount: number; requiresFileVerdict: boolean }>;
    };
    expect(listed.files).toHaveLength(1);
    expect(listed.files[0]).toMatchObject({
      file: 'src/foo.ts',
      hunkCount: 1,
      requiresFileVerdict: false,
    });

    await expect(diffTool!.handler({ file: 'src/foo.ts' })).resolves.toContain('+new');
    await expect(diffTool!.handler({ file: '../outside.ts' })).resolves.toContain('rejected');
    await expect(diffTool!.handler({ file: 'src/missing.ts' })).resolves.toContain('not found');
  });

  it('validates submissions and invokes the submission callback only once', async () => {
    const snapshot = makeSnapshot();
    const submissions: unknown[] = [];
    const submitTool = createEvaluationTools(snapshot, submission => {
      submissions.push(submission);
    }).find(tool => tool.name === 'submit_evaluation_verdicts');

    expect(submitTool).toBeDefined();

    await expect(submitTool!.handler({ verdicts: [] })).resolves.toContain('Missing evaluation verdict coverage');
    expect(submissions).toHaveLength(0);

    await expect(submitTool!.handler({
      verdicts: [
        { file: 'src/foo.ts', hunk: 1, action: 'accept', reason: 'Correct' },
      ],
    })).resolves.toContain('submitted successfully');
    expect(submissions).toHaveLength(1);

    await expect(submitTool!.handler({
      verdicts: [
        { file: 'src/foo.ts', hunk: 1, action: 'reject', reason: 'Second attempt' },
      ],
    })).resolves.toContain('already submitted');
    expect(submissions).toHaveLength(1);
  });
});
