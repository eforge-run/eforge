/**
 * Typed helpers for playbook management daemon API endpoints.
 */

import { daemonRequest } from '../daemon-client.js';
import { API_ROUTES } from '../routes.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type PlaybookScope = 'user' | 'project-team' | 'project-local';
export type PlaybookArtifactSource = 'user' | 'project-team' | 'project-local';

export interface PlaybookShadow {
  source: PlaybookArtifactSource;
  path: string;
}

/** A single entry in the merged playbook listing. */
export interface PlaybookListEntry {
  name: string;
  description: string;
  scope: PlaybookScope;
  source: PlaybookArtifactSource;
  shadows: PlaybookShadow[];
  path: string;
}

/** Fully resolved playbook (frontmatter + body sections). */
export interface PlaybookData {
  name: string;
  description: string;
  scope: PlaybookScope;
  agentRuntime?: string;
  postMerge?: string[];
  goal: string;
  outOfScope: string;
  acceptanceCriteria: string;
  plannerNotes: string;
}

/** Frontmatter-only fields for structured save requests. */
export interface PlaybookFrontmatterFields {
  name: string;
  description: string;
  scope: PlaybookScope;
  agentRuntime?: string;
  postMerge?: string[];
}

/** Body sections for structured save requests. */
export interface PlaybookBodyFields {
  goal: string;
  outOfScope: string;
  acceptanceCriteria: string;
  plannerNotes: string;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface PlaybookListResponse {
  playbooks: PlaybookListEntry[];
  warnings: string[];
}

export interface PlaybookShowResponse {
  playbook: PlaybookData;
  source: PlaybookArtifactSource;
  shadows: PlaybookShadow[];
}

export interface PlaybookSaveResponse {
  path: string;
}

export interface PlaybookEnqueueResponse {
  id: string;
}

export interface PlaybookPromoteResponse {
  path: string;
}

export interface PlaybookDemoteResponse {
  path: string;
}

export interface PlaybookValidateResponse {
  ok: boolean;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface PlaybookSaveBody {
  scope: PlaybookScope;
  playbook: {
    frontmatter: PlaybookFrontmatterFields;
    body: PlaybookBodyFields;
  };
}

// ---------------------------------------------------------------------------
// Typed client helpers
// ---------------------------------------------------------------------------

export function apiPlaybookList(opts: { cwd: string }) {
  return daemonRequest<PlaybookListResponse>(opts.cwd, 'GET', API_ROUTES.playbookList);
}

export function apiPlaybookShow(opts: { cwd: string; name: string }) {
  return daemonRequest<PlaybookShowResponse>(
    opts.cwd,
    'GET',
    `${API_ROUTES.playbookShow}?name=${encodeURIComponent(opts.name)}`,
  );
}

export function apiPlaybookSave(opts: { cwd: string; body: PlaybookSaveBody }) {
  return daemonRequest<PlaybookSaveResponse>(opts.cwd, 'POST', API_ROUTES.playbookSave, opts.body);
}

export function apiPlaybookEnqueue(opts: { cwd: string; body: { name: string; afterQueueId?: string } }) {
  return daemonRequest<PlaybookEnqueueResponse>(opts.cwd, 'POST', API_ROUTES.playbookEnqueue, opts.body);
}

export function apiPlaybookPromote(opts: { cwd: string; body: { name: string } }) {
  return daemonRequest<PlaybookPromoteResponse>(opts.cwd, 'POST', API_ROUTES.playbookPromote, opts.body);
}

export function apiPlaybookDemote(opts: { cwd: string; body: { name: string } }) {
  return daemonRequest<PlaybookDemoteResponse>(opts.cwd, 'POST', API_ROUTES.playbookDemote, opts.body);
}

export function apiPlaybookValidate(opts: { cwd: string; body: { raw: string } }) {
  return daemonRequest<PlaybookValidateResponse>(opts.cwd, 'POST', API_ROUTES.playbookValidate, opts.body);
}

export interface PlaybookCopyResponse {
  sourcePath: string;
  targetPath: string;
  targetScope: PlaybookScope;
}

export function apiPlaybookCopy(opts: {
  cwd: string;
  body: { name: string; targetScope: 'project-local' | 'project-team' | 'user' };
}) {
  return daemonRequest<PlaybookCopyResponse>(opts.cwd, 'POST', API_ROUTES.playbookCopy, opts.body);
}
