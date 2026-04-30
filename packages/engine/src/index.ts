/**
 * Engine barrel — re-exports the playbook public API and shared set-resolver
 * types that consumers (daemon routes, MCP tools, CLI, skills) should import
 * from a single stable entry point.
 *
 * Individual engine sub-modules are also importable directly via
 * `@eforge-build/engine/<module>` for callers that prefer fine-grained imports.
 */

// Playbook API
export {
  listPlaybooks,
  loadPlaybook,
  validatePlaybook,
  writePlaybook,
  movePlaybook,
  playbookToSessionPlan,
  PlaybookNotFoundError,
  playbookFrontmatterSchema,
  playbookScopeSchema,
} from './playbook.js';

export type {
  Playbook,
  PlaybookEntry,
  PlaybookBody,
  PlaybookFrontmatter,
  PlaybookScope,
  SessionPlanInput,
  ListPlaybooksOpts,
  LoadPlaybookOpts,
  WritePlaybookOpts,
  MovePlaybookOpts,
} from './playbook.js';

// Set-resolver shared types (used by playbook API surface)
export type {
  SetArtifactEntry,
  SetArtifactSource,
  SetArtifactShadow,
} from './set-resolver.js';
