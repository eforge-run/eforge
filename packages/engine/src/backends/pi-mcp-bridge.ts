/**
 * Pi MCP Bridge — bridges MCP server tools to Pi AgentTool instances.
 *
 * Spawns MCP clients lazily on first use, caches them, and exposes each
 * MCP tool as a Pi AgentTool with name `mcp_{serverName}_{toolName}`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Type, type TSchema } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// JSON Schema -> TypeBox conversion
// ---------------------------------------------------------------------------

/**
 * Recursively convert a JSON Schema object to a TypeBox TSchema.
 * Falls back to `Type.Any()` for unsupported or unrecognized schemas.
 *
 * Handles: string, number, integer, boolean, object, array, enum,
 * anyOf/oneOf, nullable, and $ref (within the same schema via definitions).
 */
export function jsonSchemaToTypeBox(
  schema: Record<string, unknown>,
  rootSchema?: Record<string, unknown>,
): TSchema {
  try {
    return jsonSchemaToTypeBoxInternal(schema, rootSchema);
  } catch {
    // Fallback for any unexpected schema structure
    return Type.Any();
  }
}

function jsonSchemaToTypeBoxInternal(
  schema: Record<string, unknown>,
  rootSchema?: Record<string, unknown>,
): TSchema {
  const root = rootSchema ?? schema;

  // Handle $ref
  if (typeof schema.$ref === 'string') {
    return resolveRef(schema.$ref, root);
  }

  // Handle anyOf / oneOf
  const unionSchemas = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
  if (Array.isArray(unionSchemas)) {
    // Check for nullable pattern: anyOf: [<schema>, { type: 'null' }]
    const nonNull = unionSchemas.filter(s => s.type !== 'null');
    if (nonNull.length === 1 && nonNull.length < unionSchemas.length) {
      return Type.Optional(jsonSchemaToTypeBoxInternal(nonNull[0], root));
    }
    const members = unionSchemas.map(s => jsonSchemaToTypeBoxInternal(s, root));
    return members.length === 1 ? members[0] : Type.Union(members);
  }

  // Handle enum
  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    if (values.length === 0) return Type.Any();
    if (values.every(v => typeof v === 'string')) {
      return Type.Union(values.map(v => Type.Literal(v as string)));
    }
    return Type.Any();
  }

  const type = schema.type as string | undefined;
  if (!type) return Type.Any();

  switch (type) {
    case 'string':
      return Type.String();

    case 'number':
      return Type.Number();

    case 'integer':
      return Type.Integer();

    case 'boolean':
      return Type.Boolean();

    case 'null':
      return Type.Null();

    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      if (!properties) return Type.Record(Type.String(), Type.Any());

      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const props: Record<string, TSchema> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        const converted = jsonSchemaToTypeBoxInternal(propSchema, root);
        props[key] = required.has(key) ? converted : Type.Optional(converted);
      }
      return Type.Object(props);
    }

    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      if (!items) return Type.Array(Type.Any());
      return Type.Array(jsonSchemaToTypeBoxInternal(items, root));
    }

    default:
      return Type.Any();
  }
}

/**
 * Resolve a JSON Schema $ref pointer within the root schema.
 * Only handles internal references like `#/definitions/Foo` or `#/$defs/Foo`.
 */
function resolveRef(ref: string, root: Record<string, unknown>): TSchema {
  if (!ref.startsWith('#/')) return Type.Any();

  const path = ref.slice(2).split('/');
  let current: unknown = root;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return Type.Any();
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return Type.Any();
  }

  if (typeof current === 'object' && current !== null) {
    return jsonSchemaToTypeBoxInternal(current as Record<string, unknown>, root);
  }
  return Type.Any();
}

// ---------------------------------------------------------------------------
// MCP Tool Wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a single MCP tool as a Pi AgentTool.
 * Delegates execution to the MCP client's `callTool` method.
 */
function createMcpToolWrapper(
  serverName: string,
  toolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  client: Client,
): AgentTool {
  const piName = `mcp_${serverName}_${toolName}`;
  const parameters = jsonSchemaToTypeBox(inputSchema);

  return {
    name: piName,
    label: `MCP: ${serverName}/${toolName}`,
    description,
    parameters,
    execute: async (_toolCallId, params) => {
      const result = await client.callTool({ name: toolName, arguments: params as Record<string, unknown> });
      const content = Array.isArray(result.content) ? result.content : [];
      const textParts = content
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { type: string; text?: string }) => ({
          type: 'text' as const,
          text: c.text ?? '',
        }));

      return {
        content: textParts.length > 0 ? textParts : [{ type: 'text', text: JSON.stringify(result.content) }],
        details: result,
      } satisfies AgentToolResult<unknown>;
    },
  };
}

// ---------------------------------------------------------------------------
// PiMcpBridge
// ---------------------------------------------------------------------------

/** MCP server config shape from .mcp.json — matches Claude SDK's McpServerConfig. */
export type McpServerConfigMap = Record<string, McpServerConfig>;

/**
 * Bridges MCP server tools to Pi AgentTool instances.
 *
 * Connects to MCP servers lazily on first use (via `getTools()`), caches clients,
 * and exposes each MCP tool as a Pi `AgentTool` named `mcp_{serverName}_{toolName}`.
 *
 * Call `close()` to shut down all MCP client connections.
 */
export class PiMcpBridge {
  private readonly serverConfigs: McpServerConfigMap;
  private readonly clients = new Map<string, Client>();
  private readonly transports = new Map<string, StdioClientTransport>();
  private toolsCache: AgentTool[] | null = null;

  constructor(serverConfigs: McpServerConfigMap) {
    this.serverConfigs = serverConfigs;
  }

  /**
   * Get all MCP tools as Pi AgentTools.
   * Connects to servers lazily on first call and caches the result.
   */
  async getTools(): Promise<AgentTool[]> {
    if (this.toolsCache) return this.toolsCache;

    const tools: AgentTool[] = [];

    for (const [serverName, config] of Object.entries(this.serverConfigs)) {
      try {
        const client = await this.connectServer(serverName, config);
        const { tools: mcpTools } = await client.listTools();

        for (const mcpTool of mcpTools) {
          tools.push(
            createMcpToolWrapper(
              serverName,
              mcpTool.name,
              mcpTool.description ?? '',
              mcpTool.inputSchema as Record<string, unknown>,
              client,
            ),
          );
        }
      } catch {
        // Failed to connect to MCP server — skip silently.
        // This is non-fatal; the agent will operate without this server's tools.
      }
    }

    this.toolsCache = tools;
    return tools;
  }

  /**
   * Connect to an MCP server and cache the client.
   */
  private async connectServer(name: string, config: McpServerConfig): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;

    // Only stdio transport is supported for now — matches .mcp.json format
    const stdioConfig = config as { command: string; args?: string[]; env?: Record<string, string> };
    const transport = new StdioClientTransport({
      command: stdioConfig.command,
      args: stdioConfig.args,
      env: stdioConfig.env ? { ...process.env, ...stdioConfig.env } as Record<string, string> : undefined,
    });

    const client = new Client({ name: `eforge-pi-${name}`, version: '1.0.0' });
    try {
      await client.connect(transport);
    } catch (err) {
      // Clean up transport (may hold subprocess handles) on connection failure
      try { await transport.close(); } catch { /* best-effort */ }
      throw err;
    }

    this.clients.set(name, client);
    this.transports.set(name, transport);
    return client;
  }

  /**
   * Close all MCP client connections and clean up resources.
   */
  async close(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch {
        // Best-effort cleanup
      }
      const transport = this.transports.get(name);
      if (transport) {
        try {
          await transport.close();
        } catch {
          // Best-effort cleanup
        }
      }
    }
    this.clients.clear();
    this.transports.clear();
    this.toolsCache = null;
  }
}
