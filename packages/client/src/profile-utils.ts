/**
 * Shared profile utility functions used by both the engine and consumer packages
 * (eforge CLI, pi-eforge extension). These are pure functions with no
 * engine-specific dependencies.
 */

/**
 * Compute a deterministic profile name from backend, provider, and model ID.
 *
 * Sanitization: lowercase, `.` -> `-`, strip `claude-` prefix from model ID,
 * collapse repeated dashes. Format: `[backend[-provider]]-[sanitized-model-id]`.
 *
 * Examples:
 * - `('claude-sdk', undefined, 'claude-opus-4.7')` -> `'claude-sdk-opus-4-7'`
 * - `('pi', 'anthropic', 'claude-opus-4.7')` -> `'pi-anthropic-opus-4-7'`
 * - `('pi', 'zai', 'glm-4.6')` -> `'pi-zai-glm-4-6'`
 */
export function sanitizeProfileName(backend: string, provider: string | undefined, modelId: string): string {
  let sanitized = modelId.toLowerCase().replace(/\./g, '-');
  sanitized = sanitized.replace(/^claude-/, '');
  const parts = [backend];
  if (provider) parts.push(provider);
  parts.push(sanitized);
  return parts.join('-').replace(/-{2,}/g, '-');
}

/**
 * Parse a pre-overhaul config.yaml that has `backend:` at the top level.
 * Extracts backend-related fields into a `profile` object and puts everything
 * else into `remaining`. Used by the `--migrate` flow.
 */
export function parseRawConfigLegacy(data: Record<string, unknown>): {
  profile: { backend?: string; pi?: unknown; agents?: unknown };
  remaining: Record<string, unknown>;
} {
  const profile: Record<string, unknown> = {};
  const remaining: Record<string, unknown> = {};

  // Extract backend-related fields into profile
  if (data.backend !== undefined) profile.backend = data.backend;
  if (data.pi !== undefined) profile.pi = data.pi;

  // Extract agent fields that belong in the profile (model configuration)
  if (data.agents !== undefined) {
    const agents = data.agents as Record<string, unknown>;
    const profileAgents: Record<string, unknown> = {};
    for (const key of ['models', 'model', 'effort', 'thinking']) {
      if (agents[key] !== undefined) profileAgents[key] = agents[key];
    }
    if (Object.keys(profileAgents).length > 0) {
      profile.agents = profileAgents;
    }
  }

  // Put everything else in remaining
  for (const [key, value] of Object.entries(data)) {
    if (key === 'backend' || key === 'pi') continue;
    if (key === 'agents') {
      const agents = value as Record<string, unknown>;
      const remainingAgents: Record<string, unknown> = {};
      for (const [ak, av] of Object.entries(agents)) {
        if (!['models', 'model', 'effort', 'thinking'].includes(ak)) {
          remainingAgents[ak] = av;
        }
      }
      if (Object.keys(remainingAgents).length > 0) {
        remaining.agents = remainingAgents;
      }
      continue;
    }
    remaining[key] = value;
  }

  return { profile: profile as { backend?: string; pi?: unknown; agents?: unknown }, remaining };
}
