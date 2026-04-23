/**
 * Tests for the MCP tool factory (`createDaemonTool`) and shared error
 * formatter (`formatMcpError` / `classifyDaemonError`).
 *
 * Follows AGENTS.md conventions:
 *  - No mocks. Real `McpServer` instances.
 *  - SDK types hand-crafted and cast through `unknown`.
 *  - Hand-crafted error objects simulate the four error classes.
 */

import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createDaemonTool,
  McpUserError,
  type RegisteredTool,
} from '../packages/eforge/src/cli/mcp-tool-factory.js';
import {
  classifyDaemonError,
  formatMcpError,
  formatCliError,
} from '../packages/eforge/src/cli/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal ToolContext extra compatible with the factory. */
function makeExtra() {
  return {
    signal: new AbortController().signal,
    _meta: { progressToken: undefined },
  } as unknown as Parameters<Parameters<typeof createDaemonTool>[2]['handler']>[1]['extra'];
}

/**
 * Register a tool via the factory and extract the registered handler so we
 * can call it directly without going through the MCP transport layer.
 * `RegisteredTool.handler` is public in SDK v1.29.
 */
function registerAndExtract<S extends Record<string, import('zod').ZodTypeAny>>(
  server: McpServer,
  spec: Parameters<typeof createDaemonTool<S>>[2],
): RegisteredTool['handler'] {
  const registered = createDaemonTool(server, '/tmp/test-cwd', spec);
  return registered.handler;
}

/** Fake extra object for tool handler calls. */
const fakeExtra = {
  signal: new AbortController().signal,
  _meta: {},
} as unknown as Parameters<RegisteredTool['handler']>[1];

// ---------------------------------------------------------------------------
// Factory: success path — default JSON formatting
// ---------------------------------------------------------------------------

describe('createDaemonTool — success path', () => {
  it('wraps a successful handler and JSON-stringifies the result with 2-space indent', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const handler = registerAndExtract(server, {
      name: 'test_tool',
      description: 'A test tool',
      schema: {},
      handler: async () => ({ status: 'ok', count: 42 }),
    });

    const result = await (handler as (...args: unknown[]) => Promise<unknown>)({}, fakeExtra);
    const typed = result as { content: Array<{ type: string; text: string }> };

    expect(typed.content).toHaveLength(1);
    expect(typed.content[0].type).toBe('text');

    const parsed = JSON.parse(typed.content[0].text);
    expect(parsed).toEqual({ status: 'ok', count: 42 });

    // Verify the 2-space indent: text should contain newlines
    expect(typed.content[0].text).toContain('\n');
    expect(typed.content[0].text).toContain('  ');
  });

  it('passes typed args through to the handler', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const { z } = await import('zod');

    let capturedSource: string | undefined;

    const handler = registerAndExtract(server, {
      name: 'test_args_tool',
      description: 'A test tool with args',
      schema: { source: z.string() },
      handler: async ({ source }) => {
        capturedSource = source;
        return { received: source };
      },
    });

    await (handler as (...args: unknown[]) => Promise<unknown>)({ source: 'my-prd.md' }, fakeExtra);
    expect(capturedSource).toBe('my-prd.md');
  });

  it('passes ctx.cwd to the handler', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    let capturedCwd: string | undefined;

    const handler = registerAndExtract(server, {
      name: 'test_cwd_tool',
      description: 'Checks that ctx.cwd is set',
      schema: {},
      handler: async (_args, ctx) => {
        capturedCwd = ctx.cwd;
        return {};
      },
    });

    await (handler as (...args: unknown[]) => Promise<unknown>)({}, fakeExtra);
    expect(capturedCwd).toBe('/tmp/test-cwd');
  });
});

// ---------------------------------------------------------------------------
// Factory: custom formatResponse
// ---------------------------------------------------------------------------

describe('createDaemonTool — custom formatResponse', () => {
  it('uses formatResponse when provided, bypassing default JSON.stringify', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const handler = registerAndExtract(server, {
      name: 'custom_format_tool',
      description: 'Custom formatter test',
      schema: {},
      handler: async () => ({ value: 'raw-data' }),
      formatResponse: (data) => ({
        content: [{ type: 'text', text: `custom:${(data as { value: string }).value}` }],
      }),
    });

    const result = await (handler as (...args: unknown[]) => Promise<unknown>)({}, fakeExtra);
    const typed = result as { content: Array<{ type: string; text: string }> };

    expect(typed.content[0].text).toBe('custom:raw-data');
  });

  it('custom formatResponse can set isError: true', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const handler = registerAndExtract(server, {
      name: 'custom_error_tool',
      description: 'Custom error formatter',
      schema: {},
      handler: async () => ({ ok: false }),
      formatResponse: (data) => ({
        content: [{ type: 'text', text: JSON.stringify(data) }],
        isError: true,
      }),
    });

    const result = await (handler as (...args: unknown[]) => Promise<unknown>)({}, fakeExtra);
    const typed = result as { content: unknown[]; isError: boolean };

    expect(typed.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Factory: McpUserError wrapping
// ---------------------------------------------------------------------------

describe('createDaemonTool — McpUserError wrapping', () => {
  it('returns isError: true with JSON-stringified data when handler throws McpUserError', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const handler = registerAndExtract(server, {
      name: 'user_error_tool',
      description: 'Throws McpUserError',
      schema: {},
      handler: async () => {
        throw new McpUserError({ status: 'aborted', sessionId: 'abc', message: 'timed out' });
      },
    });

    const result = await (handler as (...args: unknown[]) => Promise<unknown>)({}, fakeExtra);
    const typed = result as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(typed.isError).toBe(true);
    const parsed = JSON.parse(typed.content[0].text);
    expect(parsed.status).toBe('aborted');
    expect(parsed.sessionId).toBe('abc');
    expect(parsed.message).toBe('timed out');
  });
});

// ---------------------------------------------------------------------------
// Factory: error class wrapping via formatMcpError
// ---------------------------------------------------------------------------

describe('createDaemonTool — daemon error wrapping', () => {
  it('wraps daemon-down errors via formatMcpError', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const handler = registerAndExtract(server, {
      name: 'daemon_down_tool',
      description: 'Simulates daemon-down',
      schema: {},
      handler: async () => {
        // Hand-craft an ECONNREFUSED-style error (cast through unknown per AGENTS.md)
        const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4567'), {
          code: 'ECONNREFUSED',
        }) as unknown as Error;
        throw err;
      },
    });

    const result = await (handler as (...args: unknown[]) => Promise<unknown>)({}, fakeExtra);
    const typed = result as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(typed.isError).toBe(true);
    const parsed = JSON.parse(typed.content[0].text);
    expect(parsed.kind).toBe('daemon-down');
    expect(parsed.hint).toContain('eforge daemon start');
  });

  it('wraps version-mismatch errors via formatMcpError', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const handler = registerAndExtract(server, {
      name: 'version_mismatch_tool',
      description: 'Simulates version mismatch',
      schema: {},
      handler: async () => {
        throw new Error('Daemon API version-mismatch: expected 3, got 2');
      },
    });

    const result = await (handler as (...args: unknown[]) => Promise<unknown>)({}, fakeExtra);
    const typed = result as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(typed.isError).toBe(true);
    const parsed = JSON.parse(typed.content[0].text);
    expect(parsed.kind).toBe('version-mismatch');
    expect(parsed.hint).toContain('daemon restart');
  });

  it('wraps invalid-config errors via formatMcpError', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const handler = registerAndExtract(server, {
      name: 'invalid_config_tool',
      description: 'Simulates invalid config',
      schema: {},
      handler: async () => {
        throw new Error('config.yaml is missing required field: backend');
      },
    });

    const result = await (handler as (...args: unknown[]) => Promise<unknown>)({}, fakeExtra);
    const typed = result as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(typed.isError).toBe(true);
    const parsed = JSON.parse(typed.content[0].text);
    expect(parsed.kind).toBe('invalid-config');
    expect(parsed.hint).toContain('eforge/config.yaml');
  });

  it('wraps lock errors via formatMcpError', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const handler = registerAndExtract(server, {
      name: 'lock_error_tool',
      description: 'Simulates lockfile error',
      schema: {},
      handler: async () => {
        throw new Error('Failed to read lockfile: permission denied');
      },
    });

    const result = await (handler as (...args: unknown[]) => Promise<unknown>)({}, fakeExtra);
    const typed = result as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(typed.isError).toBe(true);
    const parsed = JSON.parse(typed.content[0].text);
    expect(parsed.kind).toBe('lock');
    expect(parsed.hint).toContain('eforge daemon kill');
  });

  it('wraps network errors via formatMcpError', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const handler = registerAndExtract(server, {
      name: 'network_error_tool',
      description: 'Simulates network error',
      schema: {},
      handler: async () => {
        throw new Error('fetch failed: network socket closed');
      },
    });

    const result = await (handler as (...args: unknown[]) => Promise<unknown>)({}, fakeExtra);
    const typed = result as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(typed.isError).toBe(true);
    const parsed = JSON.parse(typed.content[0].text);
    expect(parsed.kind).toBe('network');
    expect(parsed.hint).toContain('reachable');
  });
});

// ---------------------------------------------------------------------------
// classifyDaemonError — error classification
// ---------------------------------------------------------------------------

describe('classifyDaemonError', () => {
  it('classifies ECONNREFUSED as daemon-down', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:4567');
    const result = classifyDaemonError(err);
    expect(result.kind).toBe('daemon-down');
    expect(result.hint).toContain('eforge daemon start');
  });

  it('classifies "Daemon not running" as daemon-down', () => {
    const result = classifyDaemonError(new Error('Daemon not running'));
    expect(result.kind).toBe('daemon-down');
  });

  it('classifies version-mismatch errors', () => {
    const result = classifyDaemonError(new Error('api version-mismatch detected'));
    expect(result.kind).toBe('version-mismatch');
  });

  it('classifies invalid config errors', () => {
    const result = classifyDaemonError(new Error('config invalid: missing backend field'));
    expect(result.kind).toBe('invalid-config');
  });

  it('classifies lockfile errors', () => {
    const result = classifyDaemonError(new Error('lockfile is stale'));
    expect(result.kind).toBe('lock');
  });

  it('classifies network / timeout errors', () => {
    const result = classifyDaemonError(new Error('fetch failed: etimedout'));
    expect(result.kind).toBe('network');
  });

  it('classifies unknown errors as unknown', () => {
    const result = classifyDaemonError(new Error('some random error'));
    expect(result.kind).toBe('unknown');
    expect(result.hint).toBeUndefined();
  });

  it('handles non-Error thrown values', () => {
    const result = classifyDaemonError('plain string error');
    expect(result.kind).toBe('unknown');
    expect(result.message).toBe('plain string error');
  });
});

// ---------------------------------------------------------------------------
// formatMcpError — MCP surface
// ---------------------------------------------------------------------------

describe('formatMcpError', () => {
  it('returns isError: true with content array', () => {
    const result = formatMcpError(new Error('Daemon not running'));
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });

  it('includes kind and error fields in the JSON payload', () => {
    const result = formatMcpError(new Error('Daemon not running'));
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.kind).toBe('daemon-down');
    expect(typeof parsed.error).toBe('string');
    expect(typeof parsed.hint).toBe('string');
  });

  it('produces the same classification as classifyDaemonError', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:4567');
    const classified = classifyDaemonError(err);
    const mcpResult = formatMcpError(err);
    const parsed = JSON.parse(mcpResult.content[0].text);
    expect(parsed.kind).toBe(classified.kind);
    expect(parsed.error).toBe(classified.message);
  });
});

// ---------------------------------------------------------------------------
// formatCliError — CLI surface
// ---------------------------------------------------------------------------

describe('formatCliError', () => {
  it('returns exitCode 2 for daemon-down', () => {
    const { exitCode } = formatCliError(new Error('Daemon not running'));
    expect(exitCode).toBe(2);
  });

  it('returns exitCode 2 for version-mismatch', () => {
    const { exitCode } = formatCliError(new Error('api version-mismatch'));
    expect(exitCode).toBe(2);
  });

  it('returns exitCode 1 for invalid-config', () => {
    const { exitCode } = formatCliError(new Error('config invalid: bad field'));
    expect(exitCode).toBe(1);
  });

  it('returns exitCode 1 for unknown errors', () => {
    const { exitCode } = formatCliError(new Error('totally unexpected'));
    expect(exitCode).toBe(1);
  });

  it('includes hint in the message string when available', () => {
    const { message } = formatCliError(new Error('Daemon not running'));
    expect(message).toContain('Hint:');
    expect(message).toContain('eforge daemon start');
  });

  it('produces same classification as formatMcpError for daemon errors', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:4567');
    const cliResult = formatCliError(err);
    const mcpResult = formatMcpError(err);
    const mcpParsed = JSON.parse(mcpResult.content[0].text);
    // Both surfaces report daemon-down
    expect(cliResult.message).toContain(mcpParsed.error);
  });
});
