/**
 * Plan file cleanup — extracted to avoid circular imports
 * (eforge.ts → orchestrator.ts → phases.ts → eforge.ts).
 */

import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { EforgeEvent } from './events.js';
import { forgeCommit, retryOnLock } from './git.js';

const exec = promisify(execFile);

/**
 * Remove plan files after a successful build and commit the removal.
 */
export async function* cleanupPlanFiles(cwd: string, planSet: string, outputDir: string, prdFilePath?: string): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'cleanup:start', planSet };

  try {
    const planDir = resolve(cwd, outputDir, planSet);
    await retryOnLock(() => exec('git', ['rm', '-r', '--', planDir], { cwd }), cwd);

    // Remove empty output directory
    const plansDir = resolve(cwd, outputDir);
    try {
      const remaining = await readdir(plansDir);
      if (remaining.length === 0) {
        await rm(plansDir, { recursive: true });
      }
    } catch { /* may already be gone */ }

    // Also remove PRD file when provided
    if (prdFilePath) {
      try {
        // git rm (tracked files), fall back to fs rm (untracked)
        try {
          await retryOnLock(() => exec('git', ['rm', '-f', '--', prdFilePath], { cwd }), cwd);
        } catch {
          await rm(resolve(cwd, prdFilePath));
          // Stage the deletion so forgeCommit picks it up
          try {
            await retryOnLock(() => exec('git', ['add', '--', prdFilePath], { cwd }), cwd);
          } catch { /* file may have been untracked */ }
        }


      } catch { /* PRD file may not exist or already removed */ }
    }

    const commitMsg = prdFilePath
      ? `cleanup(${planSet}): remove plan files and PRD`
      : `cleanup(${planSet}): remove plan files after successful build`;
    await forgeCommit(cwd, commitMsg);

  } catch (err) {
    // Non-fatal — ensure cleanup:complete always pairs with cleanup:start
    yield { timestamp: new Date().toISOString(), type: 'plan:progress', message: `Cleanup failed (non-fatal): ${(err as Error).message}` };
  }

  yield { timestamp: new Date().toISOString(), type: 'cleanup:complete', planSet };
}
