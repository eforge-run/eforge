/**
 * Shared identifiers and helpers that let both backends filter out eforge's
 * own integration surface from agent contexts, so eforge-run agents cannot
 * recursively invoke eforge itself.
 *
 * The user can still bring their own skills / extensions / MCP servers /
 * Claude Code plugins into eforge agent contexts — only resources owned by
 * the eforge Pi package and the eforge Claude Code plugin are scrubbed.
 *
 * Two recursion surfaces exist:
 *
 * 1. **Pi side** — `@eforge-build/pi-eforge` ships a `./extensions/eforge`
 *    extension that registers ~10 `eforge_*` tools, plus skills under
 *    `./skills/*` that teach agents to invoke those tools. Pi's
 *    DefaultResourceLoader auto-loads them from any installed pi-package, so
 *    eforge must filter them out when constructing agent sessions.
 *
 * 2. **Claude SDK side** — the `eforge` Claude Code plugin registers an MCP
 *    server also named `eforge` (see eforge-plugin/.mcp.json), whose tools
 *    are exposed as `mcp__eforge__<name>`. Whenever `settingSources` includes
 *    project/user scopes, the user's installed eforge plugin leaks into
 *    subagent contexts. We block those tools via `disallowedTools` patterns
 *    which take effect regardless of how the plugin was loaded.
 */

/** Package name that ships eforge's Pi extension + skills. */
export const EFORGE_PI_PACKAGE_NAME = '@eforge-build/pi-eforge';

/** Claude Code plugin name (from eforge-plugin/.claude-plugin/plugin.json). */
export const EFORGE_CLAUDE_CODE_PLUGIN_NAME = 'eforge';

/** MCP server name the eforge plugin registers (from eforge-plugin/.mcp.json). */
export const EFORGE_MCP_SERVER_NAME = 'eforge';

/**
 * Tool-name glob patterns that the Claude Code CLI will interpret and block.
 * Claude Code MCP tools are named `mcp__<serverName>__<toolName>`, so
 * `mcp__eforge__*` matches every tool exposed by the eforge plugin.
 */
export const EFORGE_DISALLOWED_TOOL_PATTERNS: readonly string[] = Object.freeze([
  `mcp__${EFORGE_MCP_SERVER_NAME}__*`,
]);

/**
 * Decide whether a Pi resource (extension / skill / prompt / theme) was
 * contributed by the `@eforge-build/pi-eforge` package.
 *
 * Pi resources expose both a filesystem path (`Extension.resolvedPath`,
 * `Skill.filePath`, etc.) and a `SourceInfo.source` that identifies the
 * owning package. `source` is the npm package name when installed from the
 * registry and a filesystem path when installed from a local pi-package
 * directory. We match both shapes.
 */
export function isEforgePiResource(params: {
  /** Resolved filesystem path of the resource file (e.g. Extension.resolvedPath, Skill.filePath). */
  resolvedPath: string;
  /** Optional `SourceInfo.source` string attached to the resource. */
  sourceInfoSource?: string | undefined;
}): boolean {
  const { resolvedPath, sourceInfoSource } = params;

  // 1. Published / scoped-name case: source matches the exact package name
  //    (optionally with a version suffix like `@eforge-build/pi-eforge@1.2.3`).
  if (sourceInfoSource) {
    if (
      sourceInfoSource === EFORGE_PI_PACKAGE_NAME ||
      sourceInfoSource.startsWith(`${EFORGE_PI_PACKAGE_NAME}@`)
    ) {
      return true;
    }
    // 2. Local-path install case: source is a filesystem path ending in
    //    `/pi-eforge` or containing `/pi-eforge/` as a segment.
    if (hasPiEforgeSegment(sourceInfoSource)) {
      return true;
    }
  }

  // 3. As a safety net, match on the resolved file path itself (extensions
  //    register under `<pkg>/extensions/eforge`, skills under `<pkg>/skills`).
  //    Both will contain `/pi-eforge/` once resolved.
  if (hasPiEforgeSegment(resolvedPath)) {
    return true;
  }

  return false;
}

function hasPiEforgeSegment(value: string): boolean {
  // Normalize Windows paths to POSIX separators before segment-testing so
  // the same predicate works on both platforms. We intentionally match the
  // `pi-eforge` directory segment rather than a bare substring to avoid
  // accidental matches on e.g. `foo-pi-eforge-helpers`.
  const normalized = value.replace(/\\/g, '/');
  if (normalized.endsWith('/pi-eforge')) return true;
  return normalized.includes('/pi-eforge/');
}
