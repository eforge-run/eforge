/**
 * Writes recovery sidecar files alongside a failed PRD:
 *   <prdId>.recovery.md  — human-readable summary with verdict and tables
 *   <prdId>.recovery.json — machine-readable contract (schemaVersion: 1)
 *
 * Both files are written atomically via write-to-temp-then-rename (POSIX-safe).
 */

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildFailureSummary, RecoveryVerdict } from '../events.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write `.recovery.md` and `.recovery.json` sidecar files next to the failed PRD.
 *
 * @param failedPrdDir - Directory that contains (or will contain) the sidecar files
 * @param prdId - PRD identifier, used as the filename stem
 * @param summary - Build failure summary assembled by `buildFailureSummary`
 * @param verdict - Parsed recovery verdict from the recovery-analyst agent
 * @returns Absolute paths to the two written files
 */
export async function writeRecoverySidecar({
  failedPrdDir,
  prdId,
  summary,
  verdict,
}: {
  failedPrdDir: string;
  prdId: string;
  summary: BuildFailureSummary;
  verdict: RecoveryVerdict;
}): Promise<{ mdPath: string; jsonPath: string }> {
  const mdPath = join(failedPrdDir, `${prdId}.recovery.md`);
  const jsonPath = join(failedPrdDir, `${prdId}.recovery.json`);

  // Ensure target directory exists
  await mkdir(failedPrdDir, { recursive: true });

  // --- JSON sidecar (machine contract) ---
  const jsonPayload = {
    schemaVersion: 2,
    summary,
    verdict,
    generatedAt: new Date().toISOString(),
  };
  const jsonContent = JSON.stringify(jsonPayload, null, 2) + '\n';
  const jsonTmp = jsonPath + '.tmp';
  await writeFile(jsonTmp, jsonContent, 'utf-8');
  await rename(jsonTmp, jsonPath);

  // --- Markdown sidecar (human-readable) ---
  const mdContent = buildMarkdown(prdId, summary, verdict);
  const mdTmp = mdPath + '.tmp';
  await writeFile(mdTmp, mdContent, 'utf-8');
  await rename(mdTmp, mdPath);

  return { mdPath, jsonPath };
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe use inside a Markdown table cell.
 * Replaces `|` with `\|` and collapses newline/carriage-return characters to a space.
 */
function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function buildMarkdown(
  prdId: string,
  summary: BuildFailureSummary,
  verdict: RecoveryVerdict,
): string {
  const lines: string[] = [
    `# Recovery Analysis: ${prdId}`,
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Set:** ${summary.setName}`,
    `**Feature Branch:** \`${summary.featureBranch}\``,
    `**Base Branch:** \`${summary.baseBranch}\``,
    `**Failed At:** ${summary.failedAt}`,
    '',
    '## Verdict',
    '',
    `**${verdict.verdict.toUpperCase()}** (confidence: ${verdict.confidence})`,
    '',
    ...(verdict.partial === true ? [
      `**⚠ Partial summary** — context was incomplete: ${verdict.recoveryError ?? 'state.json was missing'}`,
      '',
    ] : []),
    '## Rationale',
    '',
    verdict.rationale,
    '',
    '## Plans',
    '',
    '| Plan | Status | Error |',
    '|------|--------|-------|',
    ...summary.plans.map(p => `| ${escapeTableCell(p.planId)} | ${escapeTableCell(p.status)} | ${escapeTableCell(p.error ?? '')} |`),
    '',
    '## Failing Plan',
    '',
    `**Plan ID:** ${summary.failingPlan.planId}`,
  ];

  if (summary.failingPlan.errorMessage) {
    lines.push(`**Error:** ${summary.failingPlan.errorMessage}`);
  }
  lines.push('');

  if (summary.landedCommits.length > 0) {
    lines.push('## Landed Commits', '');
    lines.push('| SHA | Subject | Author | Date |');
    lines.push('|-----|---------|--------|------|');
    for (const commit of summary.landedCommits) {
      const shortSha = commit.sha.slice(0, 8);
      lines.push(`| \`${shortSha}\` | ${escapeTableCell(commit.subject)} | ${escapeTableCell(commit.author)} | ${escapeTableCell(commit.date)} |`);
    }
    lines.push('');
  }

  if (summary.modelsUsed.length > 0) {
    lines.push('## Models Used', '');
    for (const model of summary.modelsUsed) {
      lines.push(`- ${model}`);
    }
    lines.push('');
  }

  if (verdict.completedWork.length > 0) {
    lines.push('## Completed Work', '');
    for (const item of verdict.completedWork) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (verdict.remainingWork.length > 0) {
    lines.push('## Remaining Work', '');
    for (const item of verdict.remainingWork) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (verdict.risks.length > 0) {
    lines.push('## Risks', '');
    for (const risk of verdict.risks) {
      lines.push(`- ${risk}`);
    }
    lines.push('');
  }

  if (verdict.suggestedSuccessorPrd) {
    lines.push('## Suggested Successor PRD', '');
    lines.push('```markdown');
    lines.push(verdict.suggestedSuccessorPrd);
    lines.push('```');
    lines.push('');
  }

  if (summary.diffStat) {
    lines.push('## Diff Stat', '');
    lines.push('```');
    lines.push(summary.diffStat);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}
