/**
 * Recovery verdict dispatch helpers — apply the verdict from a recovery sidecar.
 *
 * Each mutating helper performs one atomic git mutation and produces a single
 * forgeCommit. `manual` is a no-op: it returns without touching the working tree.
 *
 * Callers are expected to have already validated the verdict via recoveryVerdictSchema
 * before invoking these helpers.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { forgeCommit, retryOnLock } from '../git.js';
import { composeCommitMessage } from '../model-tracker.js';
import type { ModelTracker } from '../model-tracker.js';
import type { RecoveryVerdict } from '../events.js';
import { enqueuePrd, inferTitle } from '../prd-queue.js';

const exec = promisify(execFile);

export interface ApplyHelperOptions {
  /** Absolute working directory (repo root). */
  cwd: string;
  /** Plan ID of the failed PRD. */
  prdId: string;
  /** Absolute path to the queue directory (e.g. `<cwd>/eforge/queue`). */
  queueDir: string;
  /** Optional model tracker — when present, appends Models-Used: trailer. */
  modelTracker?: ModelTracker;
}

/**
 * Apply a `retry` verdict: move the failed PRD back to the queue and remove both
 * sidecar files. Auto-build will pick up the requeued PRD on the next tick.
 * This helper does NOT call enqueue() — the queue watcher handles it automatically.
 */
export async function applyRecoveryRetry(
  options: ApplyHelperOptions,
): Promise<{ commitSha: string }> {
  const { cwd, prdId, queueDir, modelTracker } = options;
  const failedDir = join(queueDir, 'failed');
  const failedPrdPath = join(failedDir, `${prdId}.md`);
  const queuedPrdPath = join(queueDir, `${prdId}.md`);
  const recoveryMdPath = join(failedDir, `${prdId}.recovery.md`);
  const recoveryJsonPath = join(failedDir, `${prdId}.recovery.json`);

  // Stage: move failed PRD back to queue
  await retryOnLock(
    () => exec('git', ['mv', '--', failedPrdPath, queuedPrdPath], { cwd }),
    cwd,
  );
  // Stage: remove both sidecar files
  await retryOnLock(
    () => exec('git', ['rm', '--', recoveryMdPath, recoveryJsonPath], { cwd }),
    cwd,
  );

  const message = composeCommitMessage(
    `recover(${prdId}): requeue per recovery verdict`,
    modelTracker,
  );
  await forgeCommit(cwd, message);

  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd });
  return { commitSha: stdout.trim() };
}

/**
 * Apply a `split` verdict: write the suggested successor PRD to the queue directory.
 * The failed PRD and both sidecars remain under `failed/` as the audit trail.
 *
 * The agent's `suggestedSuccessorPrd` is treated as body only — any YAML frontmatter
 * is stripped before passing to `enqueuePrd`, which rebuilds clean frontmatter with
 * `depends_on: []`.
 */
export async function applyRecoverySplit(
  options: ApplyHelperOptions,
  verdict: RecoveryVerdict,
): Promise<{ commitSha: string; successorPrdId: string }> {
  const { cwd, prdId, queueDir, modelTracker } = options;

  if (!verdict.suggestedSuccessorPrd) {
    throw new Error(`split verdict for ${prdId} is missing suggestedSuccessorPrd`);
  }

  // Strip any agent-emitted YAML frontmatter and leading whitespace
  const body = verdict.suggestedSuccessorPrd
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/^\s+/, '');

  const title = inferTitle(body);

  const { id: successorPrdId, filePath: successorPath } = await enqueuePrd({
    body,
    title,
    queueDir,
    cwd,
    depends_on: [],
  });

  await retryOnLock(
    () => exec('git', ['add', '--', successorPath], { cwd }),
    cwd,
  );

  const message = composeCommitMessage(
    `recover(${prdId}): enqueue successor ${successorPrdId}`,
    modelTracker,
  );
  await forgeCommit(cwd, message);

  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd });
  return { commitSha: stdout.trim(), successorPrdId };
}

/**
 * Apply an `abandon` verdict: permanently remove the failed PRD and both sidecar
 * files from the repository. The removal is committed atomically.
 */
export async function applyRecoveryAbandon(
  options: ApplyHelperOptions,
): Promise<{ commitSha: string }> {
  const { cwd, prdId, queueDir, modelTracker } = options;
  const failedDir = join(queueDir, 'failed');
  const failedPrdPath = join(failedDir, `${prdId}.md`);
  const recoveryMdPath = join(failedDir, `${prdId}.recovery.md`);
  const recoveryJsonPath = join(failedDir, `${prdId}.recovery.json`);

  await retryOnLock(
    () => exec('git', ['rm', '--', failedPrdPath, recoveryMdPath, recoveryJsonPath], { cwd }),
    cwd,
  );

  const message = composeCommitMessage(
    `recover(${prdId}): abandon per recovery verdict`,
    modelTracker,
  );
  await forgeCommit(cwd, message);

  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd });
  return { commitSha: stdout.trim() };
}

/**
 * Apply a `manual` verdict: no-op — no git changes are made.
 * Returns `{ noAction: true }` so callers can surface guidance to read the
 * recovery report and act manually.
 */
export async function applyRecoveryManual(
  _options: ApplyHelperOptions,
): Promise<{ noAction: true }> {
  return { noAction: true };
}
