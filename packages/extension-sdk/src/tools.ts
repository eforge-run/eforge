/**
 * Extension-contributed tool types.
 *
 * `ExtensionTool` defines the public, narrower shape that extension authors use
 * to register custom tools. The engine's internal `CustomTool` is a superset;
 * when runtime loading lands the engine will adapt extension tools, but this
 * public type stays narrow so the engine can evolve internal fields freely.
 */

import type { TObject, Static } from '@sinclair/typebox';

/**
 * A tool that an extension contributes to the eforge agent runtime.
 *
 * @typeParam TInput - TypeBox `TObject` schema describing the tool's input.
 *
 * @example
 * ```ts
 * import { Type, defineExtensionTool } from '@eforge-build/extension-sdk';
 *
 * const greet = defineExtensionTool({
 *   name: 'greet',
 *   description: 'Greet a user by name',
 *   inputSchema: Type.Object({ name: Type.String() }),
 *   handler: async ({ name }) => `Hello, ${name}!`,
 * });
 * ```
 */
export interface ExtensionTool<TInput extends TObject = TObject> {
  /** Unique tool name (should be namespaced, e.g. `my-ext:greet`). */
  name: string;
  /** Human-readable description shown to the agent. */
  description: string;
  /** TypeBox `TObject` schema for validating the tool's input at runtime. */
  inputSchema: TInput;
  /** Handler invoked when the agent calls this tool. */
  handler: (input: Static<TInput>) => Promise<string> | string;
}

/**
 * Identity helper for defining an `ExtensionTool` with correct type inference.
 *
 * Using this wrapper ensures TypeScript infers the `TInput` parameter from the
 * `inputSchema` field and propagates it to the `handler` argument type.
 *
 * @example
 * ```ts
 * const myTool = defineExtensionTool({
 *   name: 'my-ext:greet',
 *   description: 'Greet a user',
 *   inputSchema: Type.Object({ name: Type.String() }),
 *   handler: async ({ name }) => `Hello, ${name}!`,
 * });
 * ```
 */
export function defineExtensionTool<TInput extends TObject>(
  tool: ExtensionTool<TInput>,
): ExtensionTool<TInput> {
  return tool;
}
