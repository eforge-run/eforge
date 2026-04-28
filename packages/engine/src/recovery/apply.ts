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
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { forgeCommit, retryOnLock } from '../git.js';
import { composeCommitMessage } from '../model-tracker.js';
import type { ModelTracker } from '../model-tracker.js';
import type { RecoveryVerdict } from '../events.js';

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
 * Derive a unique successor PRD ID from the suggested PRD content.
 *
 * Extraction rules:
 *  1. Find the first Markdown heading (`# Title`) in the content.
 *  2. Slugify: lowercase, replace non-alphanumeric runs with `-`, trim leading/trailing `-`.
 *  3. On collision with an existing `.md` file in `queueDir` OR with `failedPrdId`,
 *     append `-1`, `-2`, ... until unique.
 *
 * The collision check covers files already present in the queue directory so that
 * two concurrent split verdicts targeting similar headings do not produce the same id.
 */
export async function deriveSuccessorPrdId(
  prdContent: string,
  queueDir: string,
  failedPrdId: string,
): Promise<string> {
  // Extract first markdown heading
  const headingMatch = prdContent.match(/^#\s+(.+)$/m);
  const headingText = headingMatch ? headingMatch[1].trim() : 'successor';

  // Slugify: lowercase, replace non-alphanumeric runs with `-`, trim leading/trailing dashes
  const slug =
    headingText
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'successor';

  // Collect existing PRD IDs from the queue directory
  let existingFiles: string[] = [];
  try {
    existingFiles = await readdir(queueDir);
  } catch {
    // Queue dir may not exist yet — no collisions
  }
  const existingIds = new Set(
    existingFiles.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)),
  );

  // Check base slug first
  if (slug !== failedPrdId && !existingIds.has(slug)) {
    return slug;
  }

  // Append numeric suffix until unique
  for (let i = 1; i <= 999; i++) {
    const candidate = `${slug}-${i}`;
    if (candidate !== failedPrdId && !existingIds.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to derive a unique successor PRD ID from heading "${headingText}"`);
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
 * Successor ID derivation: see `deriveSuccessorPrdId`.
 */
export async function applyRecoverySplit(
  options: ApplyHelperOptions,
  verdict: RecoveryVerdict,
): Promise<{ commitSha: string; successorPrdId: string }> {
  const { cwd, prdId, queueDir, modelTracker } = options;

  if (!verdict.suggestedSuccessorPrd) {
    throw new Error(`split verdict for ${prdId} is missing suggestedSuccessorPrd`);
  }

  const successorPrdId = await deriveSuccessorPrdId(verdict.suggestedSuccessorPrd, queueDir, prdId);
  const successorPath = join(queueDir, `${successorPrdId}.md`);

  // Write and stage the successor PRD
  await writeFile(successorPath, verdict.suggestedSuccessorPrd, 'utf-8');
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
