/**
 * Re-exports TypeBox primitives used for defining extension tool input schemas.
 *
 * Extension authors can import `Type`, `TSchema`, `TObject`, and `Static` from
 * `@eforge-build/extension-sdk` directly — no need to add `@sinclair/typebox`
 * as a separate dependency.
 */

export { Type } from '@sinclair/typebox';
export type { TSchema, TObject, Static } from '@sinclair/typebox';
