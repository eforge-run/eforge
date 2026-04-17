/**
 * Models adapter — surfaces available providers and models for each backend.
 *
 * Pi-aware: lazy-imports `@mariozechner/pi-ai` so claude-sdk-only users do
 * not pull the pi runtime unless they call a model-listing endpoint.
 *
 * For `claude-sdk`, providers are implicit (always Anthropic) so
 * `listProviders('claude-sdk')` returns []. `listModels('claude-sdk')`
 * reuses pi-ai's `anthropic` provider entries — same model ids the
 * Claude SDK backend accepts.
 */

export type BackendName = 'claude-sdk' | 'pi';

export interface ModelInfo {
  id: string;
  provider?: string;
  contextWindow?: number;
  releasedAt?: string;
  deprecated?: boolean;
}

interface PiAiModelLike {
  id: string;
  provider?: string;
  contextWindow?: number;
  releasedAt?: string;
  deprecated?: boolean;
}

interface PiAiModule {
  getProviders(): readonly string[];
  getModels(provider: string): readonly PiAiModelLike[];
}

async function loadPiAi(): Promise<PiAiModule> {
  const mod = await import('@mariozechner/pi-ai');
  return mod as unknown as PiAiModule;
}

/**
 * List provider names for the given backend.
 *
 * - `claude-sdk`: returns [] (provider is implicit / always Anthropic)
 * - `pi`: returns all providers known to pi-ai's static registry
 */
export async function listProviders(backend: BackendName): Promise<string[]> {
  if (backend === 'claude-sdk') {
    return [];
  }
  const piAi = await loadPiAi();
  return [...piAi.getProviders()];
}

/**
 * Compare two models for ordering: newest-first by `releasedAt` when present,
 * otherwise preserve the input order (stable sort).
 */
function compareByRelease(a: ModelInfo, b: ModelInfo): number {
  if (a.releasedAt && b.releasedAt) {
    return a.releasedAt < b.releasedAt ? 1 : a.releasedAt > b.releasedAt ? -1 : 0;
  }
  if (a.releasedAt && !b.releasedAt) return -1;
  if (!a.releasedAt && b.releasedAt) return 1;
  return 0;
}

function pickFields(m: PiAiModelLike, opts?: { includeProvider?: boolean }): ModelInfo {
  const out: ModelInfo = { id: m.id };
  if (opts?.includeProvider !== false && m.provider) {
    out.provider = m.provider;
  }
  if (typeof m.contextWindow === 'number') out.contextWindow = m.contextWindow;
  if (typeof m.releasedAt === 'string') out.releasedAt = m.releasedAt;
  if (typeof m.deprecated === 'boolean') out.deprecated = m.deprecated;
  return out;
}

/**
 * List models for the given backend, optionally filtered to a single provider.
 *
 * - `claude-sdk`: returns Anthropic Claude models (provider field omitted).
 *   The `provider` argument is ignored.
 * - `pi`: when `provider` is given, returns only that provider's models;
 *   otherwise returns models across all known providers.
 *
 * Models with release metadata sort newest-first; otherwise the input order
 * (registry order) is preserved.
 */
export async function listModels(
  backend: BackendName,
  provider?: string,
): Promise<ModelInfo[]> {
  const piAi = await loadPiAi();

  if (backend === 'claude-sdk') {
    const anthropicModels = [...piAi.getModels('anthropic')];
    const mapped = anthropicModels.map((m) => pickFields(m, { includeProvider: false }));
    return mapped.sort(compareByRelease);
  }

  if (provider) {
    const models = [...piAi.getModels(provider)];
    return models.map((m) => pickFields(m)).sort(compareByRelease);
  }

  const out: ModelInfo[] = [];
  for (const p of piAi.getProviders()) {
    for (const m of piAi.getModels(p)) {
      out.push(pickFields(m));
    }
  }
  return out.sort(compareByRelease);
}
