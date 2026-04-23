/**
 * MCP tool factory for the eforge daemon proxy.
 *
 * `createDaemonTool` wraps `server.tool` registration with:
 *   - Uniform JSON response formatting (2-space indent by default)
 *   - Optional per-tool `formatResponse` override
 *   - Error wrapping via `formatMcpError` / `McpUserError`
 *   - A typed `ToolContext` object threaded into every handler (cwd, extra, server)
 *
 * Tools that need progress notifications or elicitations receive `ctx.server`
 * (the `McpServer`) and `ctx.extra` (the per-call `RequestHandlerExtra`).
 */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatMcpError } from './errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The MCP text-content payload returned by every tool. */
export interface McpContent {
  type: 'text';
  text: string;
}

/** Full MCP tool result shape (matches `CallToolResult`). */
export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

/**
 * Per-call context object threaded into every `DaemonToolSpec` handler.
 *
 * - `cwd`    — project working directory (closed over from `runMcpProxy(cwd)`)
 * - `extra`  — MCP SDK request context (signal, _meta.progressToken, etc.)
 * - `server` — the `McpServer` instance (use `.server` for notifications / elicitations)
 */
export interface ToolContext {
  cwd: string;
  extra: {
    signal?: AbortSignal;
    _meta?: { progressToken?: unknown };
    [key: string]: unknown;
  };
  server: McpServer;
}

// ---------------------------------------------------------------------------
// McpUserError
// ---------------------------------------------------------------------------

/**
 * Throw `McpUserError` from a tool handler to return a structured error
 * response without going through `classifyDaemonError`.
 *
 * The factory catches this error and wraps `data` in a JSON-stringified MCP
 * error response (`isError: true`) so handlers don't need to call
 * `JSON.stringify` themselves.
 *
 * Use this for domain-level errors (e.g. "session aborted", "active builds
 * prevent shutdown") rather than daemon/network errors, which should be
 * re-thrown as plain `Error`s and handled by `formatMcpError`.
 */
export class McpUserError extends Error {
  readonly data: unknown;

  constructor(data: unknown) {
    super('MCP user error');
    this.name = 'McpUserError';
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// DaemonToolSpec
// ---------------------------------------------------------------------------

/** Zod raw shape — an object of field name → Zod schema, matching `server.tool`'s signature. */
type ZodRawShape = Record<string, z.ZodTypeAny>;

/** Infer the runtime output type from a Zod raw shape. */
type ShapeOutput<S extends ZodRawShape> = { [K in keyof S]: z.infer<S[K]> };

/**
 * Spec passed to `createDaemonTool` for each registered tool.
 *
 * @template S - Zod raw shape for the tool's input arguments.
 */
export interface DaemonToolSpec<S extends ZodRawShape> {
  /** Tool name as registered with the MCP server. */
  name: string;
  /** Human-readable description surfaced to the LLM. */
  description: string;
  /**
   * Zod raw shape for the tool's input arguments (same object you would pass
   * as the third argument to `server.tool`). Use `{}` for zero-argument tools.
   */
  schema: S;
  /**
   * Async handler. Receives typed `args` (inferred from `schema`) and a
   * `ToolContext`. Return any serialisable value; the factory JSON-stringifies
   * it with 2-space indent unless `formatResponse` is provided.
   *
   * Throw a plain `Error` to trigger `formatMcpError` (daemon/network errors).
   * Throw `McpUserError` to return a custom `isError: true` payload without
   * going through `classifyDaemonError`.
   */
  handler: (args: ShapeOutput<S>, ctx: ToolContext) => Promise<unknown>;
  /**
   * Optional override for response formatting. Receives the handler's return
   * value and must return a full `McpToolResult`. When omitted, the factory
   * uses `JSON.stringify(data, null, 2)` wrapped in the standard content shape.
   */
  formatResponse?: (data: unknown) => McpToolResult;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Register a daemon-backed MCP tool.
 *
 * Wraps `server.tool` with uniform error handling and response formatting.
 * Returns the `RegisteredTool` so callers (and tests) can access the handler
 * directly via `registeredTool.handler`.
 *
 * Note: The internal `server.tool` call casts the server through `any` to
 * avoid TypeScript overload resolution issues caused by the gap between our
 * `ZodRawShape = Record<string, z.ZodTypeAny>` and the SDK's internal
 * `ZodRawShapeCompat`, and between `McpToolResult` and `CallToolResult`
 * (which requires an index signature). Functionally identical at runtime.
 */
export function createDaemonTool<S extends ZodRawShape>(
  server: McpServer,
  cwd: string,
  spec: DaemonToolSpec<S>,
): RegisteredTool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mcpServer = server as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mcpServer.tool(spec.name, spec.description, spec.schema, async (args: any, extra: any) => {
    const ctx: ToolContext = {
      cwd,
      extra: extra as ToolContext['extra'],
      server,
    };
    try {
      const data = await spec.handler(args as ShapeOutput<S>, ctx);
      if (spec.formatResponse) return spec.formatResponse(data);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      if (err instanceof McpUserError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(err.data, null, 2) }],
          isError: true as const,
        };
      }
      return formatMcpError(err);
    }
  }) as RegisteredTool;
}
