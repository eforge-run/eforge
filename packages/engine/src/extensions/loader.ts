import { pathToFileURL } from 'node:url';

import { createJiti } from 'jiti';

import { discoverNativeExtensions } from './discovery.js';
import { createExtensionRecorder, mergeRecorderState } from './recorder.js';
import type {
  LoadedNativeExtension,
  NativeExtensionCandidate,
  NativeExtensionDiagnostic,
  NativeExtensionLoaderOptions,
  NativeExtensionLoaderStrategy,
  NativeExtensionLoadResult,
  NativeExtensionRegistry,
  EforgeExtensionFactoryShape,
} from './types.js';

export async function loadNativeExtensions(options: NativeExtensionLoaderOptions): Promise<NativeExtensionLoadResult> {
  const discovery = await discoverNativeExtensions(options);
  const diagnostics: NativeExtensionDiagnostic[] = [...discovery.diagnostics];
  const registry = createEmptyRegistry(discovery.candidates);
  registry.diagnostics.push(...discovery.diagnostics);

  for (const candidate of discovery.candidates) {
    if (candidate.status !== 'pending') continue;
    if (candidate.trustState === 'changed') {
      const diagnostic: NativeExtensionDiagnostic = {
        severity: 'warning',
        code: 'extension:trust-changed',
        message: `Skipping project-team extension "${candidate.name}" because its content has changed since it was trusted. Re-trust the extension to load it.`,
        name: candidate.name,
        path: candidate.path,
        scope: candidate.scope,
        source: candidate.source,
        ...(candidate.currentHash !== undefined && { currentHash: candidate.currentHash }),
        ...(candidate.trustedHash !== undefined && { trustedHash: candidate.trustedHash }),
      };
      candidate.status = 'skipped';
      candidate.diagnostics.push(diagnostic);
      diagnostics.push(diagnostic);
      registry.diagnostics.push(diagnostic);
      continue;
    }
    if (candidate.trustState === 'untrusted' || (candidate.trustState === undefined && candidate.trust === 'untrusted')) {
      const diagnostic: NativeExtensionDiagnostic = {
        severity: 'warning',
        code: 'extension:untrusted',
        message: `Skipping untrusted project-team extension "${candidate.name}". Trust the extension via \`eforge extension trust\` to load it.`,
        name: candidate.name,
        path: candidate.path,
        scope: candidate.scope,
        source: candidate.source,
        ...(candidate.currentHash !== undefined && { currentHash: candidate.currentHash }),
      };
      candidate.status = 'skipped';
      candidate.diagnostics.push(diagnostic);
      diagnostics.push(diagnostic);
      registry.diagnostics.push(diagnostic);
      continue;
    }
    if (!candidate.entrypoint || !candidate.format) {
      const diagnostic: NativeExtensionDiagnostic = {
        severity: 'error',
        code: 'extension:missing-entrypoint',
        message: `Extension "${candidate.name}" has no resolved entrypoint`,
        name: candidate.name,
        path: candidate.path,
        scope: candidate.scope,
        source: candidate.source,
      };
      candidate.status = 'error';
      candidate.diagnostics.push(diagnostic);
      diagnostics.push(diagnostic);
      registry.diagnostics.push(diagnostic);
      continue;
    }

    const strategy = loaderStrategyForFormat(candidate.format);
    try {
      const moduleExports = await importExtension(candidate.entrypoint, strategy);
      const factory = extractFactory(moduleExports);
      if (!factory) {
        throw new InvalidExtensionExportError('Default export must be an extension factory function');
      }
      const recorder = createExtensionRecorder(candidate.name, candidate.path);
      await factory(recorder.api);
      const beforeCounts = registrationCounts(registry);
      const mergeDiagnostics = mergeRecorderState(registry, recorder.state);
      const acceptedCounts = diffRegistrationCounts(beforeCounts, registrationCounts(registry));
      diagnostics.push(...mergeDiagnostics);
      candidate.diagnostics.push(...mergeDiagnostics.filter((d) => d.path === candidate.path));
      candidate.status = 'loaded';
      registry.extensions.push(buildLoadedExtension(candidate, strategy, acceptedCounts));
    } catch (err) {
      const diagnostic: NativeExtensionDiagnostic = {
        severity: 'error',
        code: err instanceof InvalidExtensionExportError ? 'extension:invalid-export' : 'extension:factory-error',
        message: `Failed to load extension "${candidate.name}": ${err instanceof Error ? err.message : String(err)}`,
        name: candidate.name,
        path: candidate.path,
        scope: candidate.scope,
        source: candidate.source,
      };
      candidate.status = 'error';
      candidate.diagnostics.push(diagnostic);
      diagnostics.push(diagnostic);
      registry.diagnostics.push(diagnostic);
    }
  }

  registry.candidates = discovery.candidates;
  return { registry, diagnostics, candidates: discovery.candidates };
}

function createEmptyRegistry(candidates: NativeExtensionCandidate[]): NativeExtensionRegistry {
  return {
    extensions: [],
    candidates,
    eventHooks: [],
    agentRunHooks: [],
    policyGates: [],
    profileRouters: [],
    inputSources: [],
    reviewerPerspectives: [],
    validationProviders: [],
    tools: [],
    diagnostics: [],
  };
}

type RegistrationCounts = LoadedNativeExtension['registrations'];

function registrationCounts(registry: NativeExtensionRegistry): RegistrationCounts {
  return {
    eventHooks: registry.eventHooks.length,
    agentRunHooks: registry.agentRunHooks.length,
    policyGates: registry.policyGates.length,
    profileRouters: registry.profileRouters.length,
    inputSources: registry.inputSources.length,
    reviewerPerspectives: registry.reviewerPerspectives.length,
    validationProviders: registry.validationProviders.length,
    tools: registry.tools.length,
  };
}

function diffRegistrationCounts(before: RegistrationCounts, after: RegistrationCounts): RegistrationCounts {
  return {
    eventHooks: after.eventHooks - before.eventHooks,
    agentRunHooks: after.agentRunHooks - before.agentRunHooks,
    policyGates: after.policyGates - before.policyGates,
    profileRouters: after.profileRouters - before.profileRouters,
    inputSources: after.inputSources - before.inputSources,
    reviewerPerspectives: after.reviewerPerspectives - before.reviewerPerspectives,
    validationProviders: after.validationProviders - before.validationProviders,
    tools: after.tools - before.tools,
  };
}

function buildLoadedExtension(candidate: NativeExtensionCandidate, strategy: NativeExtensionLoaderStrategy, registrations: RegistrationCounts): LoadedNativeExtension {
  return {
    name: candidate.name,
    path: candidate.path,
    entrypoint: candidate.entrypoint!,
    scope: candidate.scope,
    source: candidate.source,
    strategy,
    registrations,
  };
}

function loaderStrategyForFormat(format: string): NativeExtensionLoaderStrategy {
  return format === 'ts' || format === 'mts' ? 'jiti' : 'dynamic-import';
}

async function importExtension(entrypoint: string, strategy: NativeExtensionLoaderStrategy): Promise<unknown> {
  if (strategy === 'dynamic-import') {
    return import(pathToFileURL(entrypoint).href);
  }
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  return jiti.import(entrypoint);
}

function extractFactory(moduleExports: unknown): EforgeExtensionFactoryShape | null {
  if (typeof moduleExports === 'function') return moduleExports as EforgeExtensionFactoryShape;
  if (!moduleExports || typeof moduleExports !== 'object') return null;
  const mod = moduleExports as Record<string, unknown>;
  if (typeof mod.default === 'function') return mod.default as EforgeExtensionFactoryShape;
  if (mod.default && typeof mod.default === 'object' && typeof (mod.default as Record<string, unknown>).default === 'function') {
    return (mod.default as Record<string, unknown>).default as EforgeExtensionFactoryShape;
  }
  return null;
}

class InvalidExtensionExportError extends Error {}
