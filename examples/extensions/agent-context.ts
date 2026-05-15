/**
 * Example: Agent prompt-context extension (EXTEND_08A)
 *
 * This extension demonstrates how to use the `onAgentRun` hook to append
 * role- and tier-scoped context to agent prompts at runtime. The context
 * is appended AFTER the resolved `promptAppend` from the eforge config, in
 * a named provenance section.
 *
 * Supported fields in this slice:
 *   - `promptAppend` — appended to the agent's final prompt with provenance
 *
 * Deferred to EXTEND_08B (returning them emits an unsupported diagnostic):
 *   - `tools`, `allowedTools`, `disallowedTools`
 */

import type { EforgeExtensionFactory } from '@eforge-build/extension-sdk';

const extension: EforgeExtensionFactory = (api) => {
  api.onAgentRun(async (ctx) => {
    // Only augment builder and reviewer agents in the implementation tier.
    // Other roles (e.g. planner, evaluator) are left untouched.
    if (ctx.role !== 'builder' && ctx.role !== 'reviewer') {
      return undefined;
    }

    if (ctx.tier !== 'implementation') {
      return undefined;
    }

    // Provide project-specific context for implementation-tier agents.
    // The text returned here is appended to the prompt in a fenced
    // provenance section labeled with this extension's name.
    return {
      promptAppend: [
        '**Project conventions reminder**',
        '',
        '- All new exports must be accompanied by a JSDoc comment.',
        '- Prefer `readonly` arrays and objects where mutation is not required.',
        '- Use `satisfies` operator for type-narrowed object literals.',
        '',
        `(Applicable to: role=${ctx.role}, tier=${ctx.tier ?? 'unknown'}, phase=${ctx.phase ?? 'unknown'})`,
      ].join('\n'),
    };
  });
};

export default extension;
