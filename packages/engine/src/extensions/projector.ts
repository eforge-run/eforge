import type { NativeExtensionCandidate, NativeExtensionDiagnostic, NativeExtensionRegistry } from './types.js';

export interface NativeExtensionRegistryProjection {
  extensions: Array<{
    name: string;
    path: string;
    entrypoint: string;
    scope: string;
    source: string;
    strategy: string;
    registrations: Record<string, number>;
  }>;
  candidates: Array<{
    name: string;
    path: string;
    entrypoint?: string;
    scope: string;
    source: string;
    trust: string;
    status: string;
    shadows: Array<{ name: string; path: string; scope: string; entrypoint?: string }>;
  }>;
  diagnostics: NativeExtensionDiagnostic[];
  totals: {
    eventHooks: number;
    agentRunHooks: number;
    policyGates: number;
    profileRouters: number;
    inputSources: number;
    reviewerPerspectives: number;
    validationProviders: number;
    tools: number;
  };
}

export function projectExtensionRegistry(registry: NativeExtensionRegistry): NativeExtensionRegistryProjection {
  return {
    extensions: registry.extensions.map((extension) => ({
      name: extension.name,
      path: extension.path,
      entrypoint: extension.entrypoint,
      scope: extension.scope,
      source: extension.source,
      strategy: extension.strategy,
      registrations: { ...extension.registrations },
    })),
    candidates: registry.candidates.map(projectExtensionCandidate),
    diagnostics: registry.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    totals: {
      eventHooks: registry.eventHooks.length,
      agentRunHooks: registry.agentRunHooks.length,
      policyGates: registry.policyGates.length,
      profileRouters: registry.profileRouters.length,
      inputSources: registry.inputSources.length,
      reviewerPerspectives: registry.reviewerPerspectives.length,
      validationProviders: registry.validationProviders.length,
      tools: registry.tools.length,
    },
  };
}

function projectExtensionCandidate(candidate: NativeExtensionCandidate): NativeExtensionRegistryProjection['candidates'][number] {
  return {
    name: candidate.name,
    path: candidate.path,
    entrypoint: candidate.entrypoint,
    scope: candidate.scope,
    source: candidate.source,
    trust: candidate.trust,
    status: candidate.status,
    shadows: candidate.shadows.map((shadow) => ({
      name: shadow.name,
      path: shadow.path,
      scope: shadow.scope,
      entrypoint: shadow.entrypoint,
    })),
  };
}
