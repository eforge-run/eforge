/**
 * Event pattern matching — mirrors the shell-hook glob semantics from the eforge engine.
 *
 * Algorithm: split on `*`, escape regex-special characters in each segment,
 * join with `.*`, and anchor with `^...$`. This means `*` matches any
 * characters including `:`, so `plan:build:*` matches `plan:build:complete`.
 *
 * The implementation is ported from `packages/engine/src/hooks.ts::compilePattern`
 * so the SDK stays engine-independent while preserving 1:1 behavioural parity.
 */

/**
 * A glob-style pattern string for matching eforge event type strings.
 *
 * Supported syntax:
 * - `*` - matches any characters (including `:`)
 * - All other characters are treated as literals
 *
 * Examples:
 * - `plan:build:*` matches `plan:build:complete`, `plan:build:failed`, etc.
 * - `*:complete` matches `plan:build:complete`, `plan:review:complete`, etc.
 * - `*` matches any event type
 * - `plan:build:complete` matches exactly `plan:build:complete`
 */
export type EventPattern = string;

/**
 * Convert an `EventPattern` glob to an anchored `RegExp`.
 *
 * Regex-special characters in non-`*` segments are escaped so that
 * literal dots, brackets, etc. in event type names are never misinterpreted.
 *
 * @example
 * ```ts
 * compileEventPattern('plan:build:*')
 * // -> /^plan:build:.*$/
 *
 * compileEventPattern('*:complete')
 * // -> /^.*:complete$/
 * ```
 */
export function compileEventPattern(pattern: EventPattern): RegExp {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Check whether an `EventPattern` matches an event type string.
 *
 * @example
 * ```ts
 * matchesEventPattern('plan:build:*', 'plan:build:complete') // true
 * matchesEventPattern('plan:build:*', 'plan:review:complete') // false
 * matchesEventPattern('*', 'plan:build:complete') // true
 * ```
 */
export function matchesEventPattern(pattern: EventPattern, eventType: string): boolean {
  return compileEventPattern(pattern).test(eventType);
}
