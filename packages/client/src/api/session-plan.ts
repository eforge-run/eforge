/**
 * Typed helpers for session-plan management daemon API endpoints.
 */

import { daemonRequest } from '../daemon-client.js';
import { API_ROUTES } from '../routes.js';
import type {
  SessionPlanListResponse,
  SessionPlanShowResponse,
  SessionPlanCreateRequest,
  SessionPlanCreateResponse,
  SessionPlanSetSectionRequest,
  SessionPlanSetSectionResponse,
  SessionPlanSkipDimensionRequest,
  SessionPlanSkipDimensionResponse,
  SessionPlanSetStatusRequest,
  SessionPlanSetStatusResponse,
  SessionPlanSelectDimensionsRequest,
  SessionPlanSelectDimensionsResponse,
  SessionPlanReadinessResponse,
  SessionPlanMigrateLegacyRequest,
  SessionPlanMigrateLegacyResponse,
} from '../routes.js';

// Re-export wire types for convenience
export type {
  SessionPlanStatusWire,
  PlanningTypeWire,
  PlanningDepthWire,
  SkippedDimensionWire,
  SessionPlanListEntryWire,
  SessionPlanDataWire,
  SessionPlanListResponse,
  SessionPlanShowResponse,
  SessionPlanCreateRequest,
  SessionPlanCreateResponse,
  SessionPlanSetSectionRequest,
  SessionPlanSetSectionResponse,
  SessionPlanSkipDimensionRequest,
  SessionPlanSkipDimensionResponse,
  SessionPlanSetStatusRequest,
  SessionPlanSetStatusResponse,
  SessionPlanSelectDimensionsRequest,
  SessionPlanSelectDimensionsResponse,
  SessionPlanReadinessResponse,
  SessionPlanMigrateLegacyRequest,
  SessionPlanMigrateLegacyResponse,
} from '../routes.js';

// ---------------------------------------------------------------------------
// Typed client helpers
// ---------------------------------------------------------------------------

export function apiSessionPlanList(opts: { cwd: string }) {
  return daemonRequest<SessionPlanListResponse>(opts.cwd, 'GET', API_ROUTES.sessionPlanList);
}

export function apiSessionPlanShow(opts: { cwd: string; session: string }) {
  return daemonRequest<SessionPlanShowResponse>(
    opts.cwd,
    'GET',
    `${API_ROUTES.sessionPlanShow}?session=${encodeURIComponent(opts.session)}`,
  );
}

export function apiSessionPlanCreate(opts: { cwd: string; body: SessionPlanCreateRequest }) {
  return daemonRequest<SessionPlanCreateResponse>(opts.cwd, 'POST', API_ROUTES.sessionPlanCreate, opts.body);
}

export function apiSessionPlanSetSection(opts: { cwd: string; body: SessionPlanSetSectionRequest }) {
  return daemonRequest<SessionPlanSetSectionResponse>(
    opts.cwd,
    'POST',
    API_ROUTES.sessionPlanSetSection,
    opts.body,
  );
}

export function apiSessionPlanSkipDimension(opts: { cwd: string; body: SessionPlanSkipDimensionRequest }) {
  return daemonRequest<SessionPlanSkipDimensionResponse>(
    opts.cwd,
    'POST',
    API_ROUTES.sessionPlanSkipDimension,
    opts.body,
  );
}

export function apiSessionPlanSetStatus(opts: { cwd: string; body: SessionPlanSetStatusRequest }) {
  return daemonRequest<SessionPlanSetStatusResponse>(
    opts.cwd,
    'POST',
    API_ROUTES.sessionPlanSetStatus,
    opts.body,
  );
}

export function apiSessionPlanSelectDimensions(opts: {
  cwd: string;
  body: SessionPlanSelectDimensionsRequest;
}) {
  return daemonRequest<SessionPlanSelectDimensionsResponse>(
    opts.cwd,
    'POST',
    API_ROUTES.sessionPlanSelectDimensions,
    opts.body,
  );
}

export function apiSessionPlanReadiness(opts: { cwd: string; session: string }) {
  return daemonRequest<SessionPlanReadinessResponse>(
    opts.cwd,
    'GET',
    `${API_ROUTES.sessionPlanReadiness}?session=${encodeURIComponent(opts.session)}`,
  );
}

export function apiSessionPlanMigrateLegacy(opts: { cwd: string; body: SessionPlanMigrateLegacyRequest }) {
  return daemonRequest<SessionPlanMigrateLegacyResponse>(
    opts.cwd,
    'POST',
    API_ROUTES.sessionPlanMigrateLegacy,
    opts.body,
  );
}
