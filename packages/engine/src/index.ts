/**
 * Engine barrel — re-exports engine internals that consumers (daemon routes,
 * MCP tools, CLI, skills) should import from a single stable entry point.
 *
 * Individual engine sub-modules are also importable directly via
 * `@eforge-build/engine/<module>` for callers that prefer fine-grained imports.
 *
 * Note: Playbook API has moved to @eforge-build/input.
 * Note: Set-resolver types have moved to @eforge-build/scopes.
 */
