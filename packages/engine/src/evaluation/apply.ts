import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, posix, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { EvaluationVerdict } from '../schemas.js';
import { forgeCommit } from '../git.js';
import { composeCommitMessage, type ModelTracker } from '../model-tracker.js';

const exec = promisify(execFile);
const GIT_MAX_BUFFER = 50 * 1024 * 1024;

export type EvaluationCandidateStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'unmerged'
  | 'unknown'
  | 'untracked';

export interface EvaluationResetState {
  cwd: string;
  resetTarget: string;
  originalHead: string;
  baseHead: string;
}

export interface EvaluationCandidateHunk {
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  diff: string;
}

export interface EvaluationCandidateFile {
  path: string;
  oldPath?: string;
  status: EvaluationCandidateStatus;
  statusCode: string;
  diff: string;
  diffHeader: string;
  hunks: EvaluationCandidateHunk[];
  isBinary: boolean;
  isUntracked: boolean;
  isRenameOnly: boolean;
  requiresFileVerdict: boolean;
  contentSha256?: string;
  contentBase64?: string;
  isSymlink?: boolean;
  symlinkTargetBase64?: string;
}

export interface EvaluationSnapshot {
  cwd: string;
  capturedAt: string;
  resetTarget?: string;
  originalHead?: string;
  baseHead: string;
  stagedPatch: string;
  candidatePatch: string;
  files: EvaluationCandidateFile[];
}

export interface EvaluationFileVerdictSummary {
  file: string;
  mode: 'file' | 'hunks';
  action?: EvaluationVerdict['action'];
  acceptedHunks: number[];
  rejectedHunks: number[];
  reviewHunks: number[];
}

export interface EvaluationVerdictSummary {
  accepted: number;
  rejected: number;
  review: number;
  fileLevel: number;
  hunkLevel: number;
  files: EvaluationFileVerdictSummary[];
}

export type EvaluationCandidateDecision =
  | { kind: 'file'; file: EvaluationCandidateFile; verdict: EvaluationVerdict }
  | { kind: 'hunks'; file: EvaluationCandidateFile; verdictsByHunk: Map<number, EvaluationVerdict> };

export interface EvaluationValidationResult {
  decisions: Map<string, EvaluationCandidateDecision>;
  summary: EvaluationVerdictSummary;
}

export interface ApplyEvaluationVerdictsOptions {
  commit?: boolean;
  commitMessage?: string;
  modelTracker?: ModelTracker;
}

export interface EvaluationApplicationResult extends EvaluationVerdictSummary {
  committed: boolean;
  commitSha?: string;
}

export class EvaluationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationValidationError';
  }
}

export class EvaluationInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationInvariantError';
  }
}

interface NameStatusEntry {
  statusCode: string;
  path: string;
  oldPath?: string;
}

interface ParsedHunks {
  diffHeader: string;
  hunks: EvaluationCandidateHunk[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  });
  return stdout;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function splitNul(output: string): string[] {
  return output.split('\0').filter(part => part.length > 0);
}

function parseNameStatusZ(output: string): NameStatusEntry[] {
  const parts = splitNul(output);
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < parts.length;) {
    const statusCode = parts[i++];
    if (!statusCode) break;
    if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
      const oldPath = parts[i++];
      const path = parts[i++];
      if (oldPath && path) entries.push({ statusCode, oldPath, path });
    } else {
      const path = parts[i++];
      if (path) entries.push({ statusCode, path });
    }
  }
  return entries;
}

function statusFromCode(statusCode: string): EvaluationCandidateStatus {
  const code = statusCode[0];
  switch (code) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'typechange';
    case 'U': return 'unmerged';
    default: return 'unknown';
  }
}

export function validateEvaluationPath(file: string): string {
  if (typeof file !== 'string' || file.trim().length === 0) {
    throw new EvaluationValidationError('Evaluation verdict path must be a non-empty relative path.');
  }
  if (file.includes('\0')) {
    throw new EvaluationValidationError(`Evaluation verdict path contains a NUL byte: ${JSON.stringify(file)}`);
  }
  const slashPath = file.replace(/\\/g, '/');
  if (slashPath.startsWith('/') || posix.isAbsolute(slashPath) || win32.isAbsolute(file)) {
    throw new EvaluationValidationError(`Evaluation verdict path must be relative, got absolute path: ${file}`);
  }
  if (slashPath.split('/').includes('..')) {
    throw new EvaluationValidationError(`Evaluation verdict path escapes the repository root: ${file}`);
  }
  const normalized = posix.normalize(slashPath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new EvaluationValidationError(`Evaluation verdict path escapes the repository root: ${file}`);
  }
  return normalized;
}

function repoAbsolutePath(cwd: string, repoPath: string): string {
  const normalized = validateEvaluationPath(repoPath);
  const absolute = resolve(cwd, normalized);
  const rel = relative(cwd, absolute);
  if (rel === '' || rel.startsWith('..') || win32.isAbsolute(rel)) {
    throw new EvaluationValidationError(`Evaluation path escapes the repository root: ${repoPath}`);
  }
  return absolute;
}

function parseHunks(diff: string): ParsedHunks {
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm;
  const matches = Array.from(diff.matchAll(hunkRegex));
  if (matches.length === 0) {
    return { diffHeader: diff, hunks: [] };
  }

  const diffHeader = diff.slice(0, matches[0].index ?? 0);
  const hunks: EvaluationCandidateHunk[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = match.index ?? 0;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? diff.length : diff.length;
    const hunkDiff = diff.slice(start, end);
    const headerEnd = hunkDiff.indexOf('\n');
    const header = headerEnd === -1 ? hunkDiff : hunkDiff.slice(0, headerEnd);
    hunks.push({
      index: i + 1,
      header,
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      diff: hunkDiff,
    });
  }
  return { diffHeader, hunks };
}

function diffLooksBinary(diff: string): boolean {
  return diff.includes('\nGIT binary patch\n') || diff.includes('\nBinary files ');
}

function bufferLooksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function syntheticUntrackedDiff(path: string, content: Buffer): string {
  if (bufferLooksBinary(content)) {
    return `Untracked binary file: ${path}\n`;
  }
  return `Untracked file: ${path}\n\n${content.toString('utf8')}`;
}

function syntheticUntrackedSymlinkDiff(path: string): string {
  return `Untracked symbolic link: ${path}\n`;
}

function candidatePaths(file: EvaluationCandidateFile): string[] {
  const paths = file.oldPath && file.oldPath !== file.path
    ? [file.oldPath, file.path]
    : [file.path];
  return Array.from(new Set(paths));
}

async function isPathInIndex(cwd: string, repoPath: string): Promise<boolean> {
  try {
    await git(cwd, ['ls-files', '--error-unmatch', '--', repoPath]);
    return true;
  } catch {
    return false;
  }
}

async function removeRepoPath(cwd: string, repoPath: string): Promise<void> {
  const absolute = repoAbsolutePath(cwd, repoPath);
  await rm(absolute, { recursive: true, force: true });
}

async function restorePathFromIndex(cwd: string, repoPath: string): Promise<void> {
  if (await isPathInIndex(cwd, repoPath)) {
    await git(cwd, ['checkout', '--', repoPath]);
  } else {
    await removeRepoPath(cwd, repoPath);
  }
}

type ApplyPatchMode = 'worktree' | 'cached' | 'index';

async function applyPatch(cwd: string, patch: string, mode: ApplyPatchMode): Promise<void> {
  if (patch.trim().length === 0) return;
  const dir = await mkdtemp(join(tmpdir(), 'eforge-evaluation-'));
  const patchPath = join(dir, 'patch.diff');
  try {
    await writeFile(patchPath, ensureTrailingNewline(patch), 'utf8');
    const modeArgs = mode === 'cached' ? ['--cached'] : mode === 'index' ? ['--index'] : [];
    await git(cwd, ['apply', '--binary', ...modeArgs, patchPath]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hunkPatch(file: EvaluationCandidateFile, hunks: EvaluationCandidateHunk[]): string {
  return ensureTrailingNewline(`${file.diffHeader}${hunks.map(h => h.diff).join('')}`);
}

async function stageFileLevelDecision(snapshot: EvaluationSnapshot, file: EvaluationCandidateFile): Promise<void> {
  const paths = candidatePaths(file);
  await git(snapshot.cwd, ['add', '-A', '--', ...paths]);
}

async function rejectFileLevelDecision(snapshot: EvaluationSnapshot, file: EvaluationCandidateFile): Promise<void> {
  if (file.isUntracked) {
    await removeRepoPath(snapshot.cwd, file.path);
    return;
  }
  for (const path of candidatePaths(file)) {
    await restorePathFromIndex(snapshot.cwd, path);
  }
}

async function applyHunkDecision(snapshot: EvaluationSnapshot, decision: Extract<EvaluationCandidateDecision, { kind: 'hunks' }>): Promise<void> {
  const acceptedHunks = decision.file.hunks.filter(hunk => decision.verdictsByHunk.get(hunk.index)?.action === 'accept');
  if (acceptedHunks.length > 0) {
    await applyPatch(snapshot.cwd, hunkPatch(decision.file, acceptedHunks), 'cached');
  }
  for (const path of candidatePaths(decision.file)) {
    await restorePathFromIndex(snapshot.cwd, path);
  }
}

async function currentUntrackedHashes(cwd: string): Promise<Map<string, string>> {
  const output = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = splitNul(output).map(validateEvaluationPath);
  const hashes = new Map<string, string>();
  for (const path of paths) {
    const absolute = repoAbsolutePath(cwd, path);
    try {
      const stat = await lstat(absolute);
      const isSymlink = stat.isSymbolicLink();
      const content = isSymlink
        ? Buffer.from(await readlink(absolute), 'utf8')
        : await readFile(absolute);
      hashes.set(path, `${isSymlink ? 'symlink' : 'file'}:${sha256(content)}`);
    } catch {
      hashes.set(path, '<unreadable>');
    }
  }
  return hashes;
}

export async function softResetForEvaluation(cwd: string, resetTarget: string): Promise<EvaluationResetState> {
  const originalHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  await git(cwd, ['reset', '--soft', '--end-of-options', resetTarget]);
  const baseHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  return { cwd, resetTarget, originalHead, baseHead };
}

export async function prepareEvaluationSnapshot(cwd: string, resetTarget: string): Promise<EvaluationSnapshot> {
  const resetState = await softResetForEvaluation(cwd, resetTarget);
  try {
    return await captureEvaluationSnapshot(cwd, resetState);
  } catch (err) {
    await git(cwd, ['reset', '--soft', resetState.originalHead]);
    throw err;
  }
}

export async function captureEvaluationSnapshot(cwd: string, resetState?: Partial<EvaluationResetState>): Promise<EvaluationSnapshot> {
  const baseHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  const stagedPatch = await git(cwd, ['diff', '--cached', '--binary', '--find-renames']);
  const candidatePatch = await git(cwd, ['diff', '--binary', '--find-renames']);
  const statusEntries = parseNameStatusZ(await git(cwd, ['diff', '--name-status', '--find-renames', '-z']));
  const files: EvaluationCandidateFile[] = [];

  for (const entry of statusEntries) {
    const path = validateEvaluationPath(entry.path);
    const oldPath = entry.oldPath ? validateEvaluationPath(entry.oldPath) : undefined;
    const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
    const diff = await git(cwd, ['diff', '--binary', '--find-renames', '--', ...paths]);
    const parsed = parseHunks(diff);
    const isBinary = diffLooksBinary(diff);
    const status = statusFromCode(entry.statusCode);
    const isRenameOnly = status === 'renamed' && parsed.hunks.length === 0 && !isBinary;
    const requiresFileVerdict = isBinary || isRenameOnly || parsed.hunks.length === 0;
    files.push({
      path,
      ...(oldPath !== undefined && { oldPath }),
      status,
      statusCode: entry.statusCode,
      diff,
      diffHeader: parsed.diffHeader,
      hunks: parsed.hunks,
      isBinary,
      isUntracked: false,
      isRenameOnly,
      requiresFileVerdict,
    });
  }

  const untrackedPaths = splitNul(await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
    .map(validateEvaluationPath);
  for (const path of untrackedPaths) {
    const absolute = repoAbsolutePath(cwd, path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const linkTarget = Buffer.from(await readlink(absolute), 'utf8');
      files.push({
        path,
        status: 'untracked',
        statusCode: '??',
        diff: syntheticUntrackedSymlinkDiff(path),
        diffHeader: '',
        hunks: [],
        isBinary: false,
        isUntracked: true,
        isRenameOnly: false,
        requiresFileVerdict: true,
        contentSha256: sha256(linkTarget),
        isSymlink: true,
        symlinkTargetBase64: linkTarget.toString('base64'),
      });
      continue;
    }
    const content = await readFile(absolute);
    files.push({
      path,
      status: 'untracked',
      statusCode: '??',
      diff: syntheticUntrackedDiff(path, content),
      diffHeader: '',
      hunks: [],
      isBinary: bufferLooksBinary(content),
      isUntracked: true,
      isRenameOnly: false,
      requiresFileVerdict: true,
      contentSha256: sha256(content),
      contentBase64: content.toString('base64'),
    });
  }

  return {
    cwd,
    capturedAt: new Date().toISOString(),
    ...(resetState?.resetTarget !== undefined && { resetTarget: resetState.resetTarget }),
    ...(resetState?.originalHead !== undefined && { originalHead: resetState.originalHead }),
    baseHead: resetState?.baseHead ?? baseHead,
    stagedPatch,
    candidatePatch,
    files,
  };
}

export function validateEvaluationVerdicts(snapshot: EvaluationSnapshot, verdicts: EvaluationVerdict[]): EvaluationValidationResult {
  const candidates = new Map(snapshot.files.map(file => [file.path, file]));
  const verdictsByFile = new Map<string, EvaluationVerdict[]>();
  const seen = new Set<string>();

  for (const rawVerdict of verdicts) {
    const file = validateEvaluationPath(rawVerdict.file);
    const candidate = candidates.get(file);
    if (!candidate) {
      throw new EvaluationValidationError(`Evaluation verdict references unknown file: ${file}`);
    }
    if (rawVerdict.action !== 'accept' && rawVerdict.action !== 'reject' && rawVerdict.action !== 'review') {
      throw new EvaluationValidationError(`Evaluation verdict for ${file} has invalid action: ${String(rawVerdict.action)}`);
    }
    if (rawVerdict.hunk !== undefined && (!Number.isInteger(rawVerdict.hunk) || rawVerdict.hunk < 1)) {
      throw new EvaluationValidationError(`Evaluation verdict for ${file} references invalid hunk: ${String(rawVerdict.hunk)}`);
    }
    const key = `${file}:${rawVerdict.hunk ?? 'file'}`;
    if (seen.has(key)) {
      throw new EvaluationValidationError(`Duplicate evaluation verdict for ${rawVerdict.hunk === undefined ? file : `${file} hunk ${rawVerdict.hunk}`}`);
    }
    seen.add(key);
    const verdict: EvaluationVerdict = { ...rawVerdict, file };
    const list = verdictsByFile.get(file) ?? [];
    list.push(verdict);
    verdictsByFile.set(file, list);
  }

  const decisions = new Map<string, EvaluationCandidateDecision>();
  const fileSummaries: EvaluationFileVerdictSummary[] = [];
  let accepted = 0;
  let rejected = 0;
  let review = 0;
  let fileLevel = 0;
  let hunkLevel = 0;

  for (const file of snapshot.files) {
    const fileVerdicts = verdictsByFile.get(file.path) ?? [];
    if (fileVerdicts.length === 0) {
      throw new EvaluationValidationError(`Missing evaluation verdict coverage for file: ${file.path}`);
    }

    const wholeFileVerdicts = fileVerdicts.filter(v => v.hunk === undefined);
    const hunkVerdicts = fileVerdicts.filter(v => v.hunk !== undefined);
    if (wholeFileVerdicts.length > 0 && hunkVerdicts.length > 0) {
      throw new EvaluationValidationError(`Mixed file-level and hunk-level evaluation verdicts for file: ${file.path}`);
    }

    if (wholeFileVerdicts.length > 0) {
      if (wholeFileVerdicts.length !== 1) {
        throw new EvaluationValidationError(`Duplicate file-level evaluation verdicts for file: ${file.path}`);
      }
      const verdict = wholeFileVerdicts[0];
      if (verdict.action === 'accept') accepted += 1;
      if (verdict.action === 'reject') rejected += 1;
      if (verdict.action === 'review') {
        rejected += 1;
        review += 1;
      }
      fileLevel += 1;
      decisions.set(file.path, { kind: 'file', file, verdict });
      fileSummaries.push({
        file: file.path,
        mode: 'file',
        action: verdict.action,
        acceptedHunks: [],
        rejectedHunks: [],
        reviewHunks: [],
      });
      continue;
    }

    if (file.hunks.length === 0) {
      const requested = hunkVerdicts[0]?.hunk;
      throw new EvaluationValidationError(
        requested === undefined
          ? `File ${file.path} has no text hunks and requires a file-level evaluation verdict.`
          : `File ${file.path} has no text hunks; hunk ${requested} cannot be evaluated at hunk level.`,
      );
    }

    const verdictsByHunk = new Map<number, EvaluationVerdict>();
    for (const verdict of hunkVerdicts) {
      const hunk = verdict.hunk;
      if (hunk === undefined) continue;
      if (hunk > file.hunks.length) {
        throw new EvaluationValidationError(`Evaluation verdict for ${file.path} references hunk ${hunk}, but only ${file.hunks.length} hunks were captured.`);
      }
      verdictsByHunk.set(hunk, verdict);
    }
    for (const hunk of file.hunks) {
      if (!verdictsByHunk.has(hunk.index)) {
        throw new EvaluationValidationError(`Missing evaluation verdict coverage for ${file.path} hunk ${hunk.index}.`);
      }
    }

    const acceptedHunks: number[] = [];
    const rejectedHunks: number[] = [];
    const reviewHunks: number[] = [];
    for (const hunk of file.hunks) {
      const verdict = verdictsByHunk.get(hunk.index);
      if (!verdict) continue;
      if (verdict.action === 'accept') {
        accepted += 1;
        acceptedHunks.push(hunk.index);
      } else if (verdict.action === 'reject') {
        rejected += 1;
        rejectedHunks.push(hunk.index);
      } else {
        rejected += 1;
        review += 1;
        reviewHunks.push(hunk.index);
      }
    }
    hunkLevel += hunkVerdicts.length;
    decisions.set(file.path, { kind: 'hunks', file, verdictsByHunk });
    fileSummaries.push({
      file: file.path,
      mode: 'hunks',
      acceptedHunks,
      rejectedHunks,
      reviewHunks,
    });
  }

  return {
    decisions,
    summary: { accepted, rejected, review, fileLevel, hunkLevel, files: fileSummaries },
  };
}

export async function assertNoEvaluationDrift(snapshot: EvaluationSnapshot): Promise<void> {
  const currentStagedPatch = await git(snapshot.cwd, ['diff', '--cached', '--binary', '--find-renames']);
  if (currentStagedPatch !== snapshot.stagedPatch) {
    throw new EvaluationInvariantError('Evaluation staged/index diff drifted from the captured snapshot.');
  }

  const currentCandidatePatch = await git(snapshot.cwd, ['diff', '--binary', '--find-renames']);
  if (currentCandidatePatch !== snapshot.candidatePatch) {
    throw new EvaluationInvariantError('Evaluation working-tree candidate diff drifted from the captured snapshot.');
  }

  const expectedUntracked = new Map(
    snapshot.files
      .filter(file => file.isUntracked)
      .map(file => [file.path, `${file.isSymlink ? 'symlink' : 'file'}:${file.contentSha256 ?? ''}`]),
  );
  const currentUntracked = await currentUntrackedHashes(snapshot.cwd);
  for (const [path, expectedHash] of expectedUntracked) {
    const actualHash = currentUntracked.get(path);
    if (actualHash !== expectedHash) {
      throw new EvaluationInvariantError(`Evaluation untracked candidate drifted from the captured snapshot: ${path}`);
    }
  }
  for (const path of currentUntracked.keys()) {
    if (!expectedUntracked.has(path)) {
      throw new EvaluationInvariantError(`Evaluation working tree has untracked drift outside the captured snapshot: ${path}`);
    }
  }
}

export async function discardEvaluationCandidateFixes(snapshot: EvaluationSnapshot): Promise<void> {
  for (const file of snapshot.files) {
    if (file.isUntracked) {
      await removeRepoPath(snapshot.cwd, file.path);
      continue;
    }
    for (const path of candidatePaths(file)) {
      await restorePathFromIndex(snapshot.cwd, path);
    }
  }
}

export async function cleanupEvaluationSnapshot(snapshot: EvaluationSnapshot): Promise<void> {
  await discardEvaluationCandidateFixes(snapshot);
}

export async function restoreEvaluationSnapshotAfterFailure(snapshot: EvaluationSnapshot): Promise<void> {
  await git(snapshot.cwd, ['reset', '--hard', snapshot.baseHead]);

  const untrackedPaths = splitNul(await git(snapshot.cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
    .map(validateEvaluationPath);
  for (const path of untrackedPaths) {
    await removeRepoPath(snapshot.cwd, path);
  }

  await applyPatch(snapshot.cwd, snapshot.stagedPatch, 'index');
  await applyPatch(snapshot.cwd, snapshot.candidatePatch, 'worktree');
  for (const file of snapshot.files) {
    if (!file.isUntracked) continue;
    const absolute = repoAbsolutePath(snapshot.cwd, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    if (file.isSymlink && file.symlinkTargetBase64) {
      await symlink(Buffer.from(file.symlinkTargetBase64, 'base64').toString('utf8'), absolute);
    } else if (file.contentBase64 !== undefined) {
      await writeFile(absolute, Buffer.from(file.contentBase64, 'base64'));
    }
  }
}

export async function commitEvaluationSnapshot(
  snapshot: EvaluationSnapshot,
  message: string,
  modelTracker?: ModelTracker,
): Promise<string> {
  await forgeCommit(snapshot.cwd, composeCommitMessage(message, modelTracker));
  return (await git(snapshot.cwd, ['rev-parse', 'HEAD'])).trim();
}

export async function applyEvaluationVerdicts(
  snapshot: EvaluationSnapshot,
  verdicts: EvaluationVerdict[],
  options: ApplyEvaluationVerdictsOptions = {},
): Promise<EvaluationApplicationResult> {
  const validation = validateEvaluationVerdicts(snapshot, verdicts);
  await assertNoEvaluationDrift(snapshot);

  try {
    for (const file of snapshot.files) {
      const decision = validation.decisions.get(file.path);
      if (!decision) {
        throw new EvaluationInvariantError(`Evaluation decision missing after validation for file: ${file.path}`);
      }
      if (decision.kind === 'file') {
        if (decision.verdict.action === 'accept') {
          await stageFileLevelDecision(snapshot, file);
        } else {
          await rejectFileLevelDecision(snapshot, file);
        }
      } else {
        await applyHunkDecision(snapshot, decision);
      }
    }

    if (options.commit === false) {
      return { ...validation.summary, committed: false };
    }

    const commitSha = await commitEvaluationSnapshot(
      snapshot,
      options.commitMessage ?? 'chore: apply evaluation verdicts',
      options.modelTracker,
    );
    return { ...validation.summary, committed: true, commitSha };
  } catch (err) {
    await restoreEvaluationSnapshotAfterFailure(snapshot);
    throw err;
  }
}
