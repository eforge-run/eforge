/**
 * @eforge-build/input — reusable input-artifact protocols for eforge.
 *
 * ## Playbooks
 *
 * Playbooks are Markdown files with YAML frontmatter encoding a reusable build
 * intent. They live in three-tier directories (project-local, project-team,
 * user) and resolve with the @eforge-build/scopes named-set infrastructure.
 *
 * ## Session Plans
 *
 * Session plans are Markdown files in `.eforge/session-plans/` that accumulate
 * decisions during a structured planning conversation. They are project-local
 * only and compile to ordinary build source for the engine queue via
 * `sessionPlanToBuildSource` or the boundary helper `normalizeBuildSource`.
 *
 * ## Boundary normalization
 *
 * `normalizeBuildSource` is the single chokepoint for session-plan handling:
 * if a source path matches `.eforge/session-plans/<name>.md`, it parses the plan
 * and converts it to ordinary build source. Other paths pass through unchanged.
 */

// ---------------------------------------------------------------------------
// Playbook exports
// ---------------------------------------------------------------------------

export {
  // Schema / types
  playbookScopeSchema,
  playbookFrontmatterSchema,

  // Parse / serialize
  parsePlaybook,
  serializePlaybook,
  validatePlaybook,

  // List / load
  listPlaybooks,
  loadPlaybook,

  // Write / move / copy
  writePlaybook,
  movePlaybook,
  copyPlaybookToScope,

  // Build source compilation
  playbookToBuildSource,
  playbookToSessionPlan,

  // Errors
  PlaybookNotFoundError,
} from './playbook.js';

export type {
  PlaybookScope,
  PlaybookFrontmatter,
  PlaybookBody,
  Playbook,
  PlaybookShadowEntry,
  PlaybookEntry,
  SessionPlanInput,
  ListPlaybooksOpts,
  LoadPlaybookOpts,
  WritePlaybookOpts,
  MovePlaybookOpts,
  CopyPlaybookToScopeOpts,
  CopyPlaybookToScopeResult,
} from './playbook.js';

// ---------------------------------------------------------------------------
// Session plan exports
// ---------------------------------------------------------------------------

export {
  // Schema
  sessionPlanFrontmatterSchema,

  // Parse / serialize
  parseSessionPlan,
  serializeSessionPlan,

  // List
  listActiveSessionPlans,

  // Dimension helpers
  selectDimensions,
  checkReadiness,
  migrateBooleanDimensions,

  // Build source compilation
  sessionPlanToBuildSource,

  // Boundary normalization
  normalizeBuildSource,
} from './session-plan.js';

export type {
  SessionPlanStatus,
  PlanningType,
  PlanningDepth,
  PlanningProfile,
  SkippedDimension,
  SessionPlanFrontmatter,
  SessionPlan,
  SessionPlanListEntry,
  ListActiveSessionPlansOpts,
  NormalizeBuildSourceInput,
  NormalizeBuildSourceResult,
} from './session-plan.js';
