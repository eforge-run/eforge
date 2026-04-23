/**
 * Pipeline barrel — re-exports every public symbol previously exported from pipeline.ts.
 *
 * IMPORTANT: Stage registration order — compile stages are imported before build stages
 * to preserve the original registration sequence within each phase's Map.
 * Both imports trigger register*Stage side effects exactly once (Node caches modules).
 */

// Side-effect imports to trigger stage registrations in the original order:
// compile stages first, then build stages.
import './stages/compile-stages.js';
import './stages/build-stages.js';

// Re-export all public symbols from the pipeline sub-modules.
export * from './types.js';
export * from './registry.js';
export * from './validate.js';
export * from './agent-config.js';
export * from './git-helpers.js';
export * from './error-translator.js';
export * from './span-wiring.js';
export * from './misc.js';
export * from './runners.js';
