import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import {
  safeParseEforgeEvent,
  type EforgeEvent,
  type ExtensionDiagnostic,
  type ExtensionEntry,
  type ExtensionRegistrationSummary,
  type ExtensionTestDeferredRegistrationFamily,
  type ExtensionTestDeferredRegistrationSummary,
  type ExtensionTestMatch,
  type ExtensionTestReplayCounts,
  type ExtensionTestResponse,
  type ExtensionTestSource,
} from '@eforge-build/client';

import { compilePattern } from '../hooks.js';
import { loadNativeExtensions } from './loader.js';
import { withNativeEventHooks } from './event-runtime.js';
import type {
  EventHookRegistration,
  NativeExtensionCandidate,
  NativeExtensionDiagnostic,
  NativeExtensionLoaderOptions,
  NativeExtensionRegistry,
} from './types.js';

export type ExtensionFixtureFormat = 'json' | 'json-array' | 'jsonl';

export interface ExtensionEventFixtureParseResult {
  valid: boolean;
  path: string;
  format?: ExtensionFixtureFormat;
  events: EforgeEvent[];
  diagnostics: ExtensionDiagnostic[];
}

export interface NativeExtensionReplayOptions {
  cwd: string;
  loaderOptions: NativeExtensionLoaderOptions;
  name?: string;
  path?: string;
  events?: EforgeEvent[];
  eventType?: string;
  timeoutMs?: number;
  source?: ExtensionTestSource;
  sourceDiagnostics?: ExtensionDiagnostic[];
}

export type NativeExtensionReplayResult = ExtensionTestResponse;
export type NativeExtensionReplaySource = ExtensionTestSource;
export type NativeExtensionReplayCounts = ExtensionTestReplayCounts;
export type NativeExtensionReplayMatch = ExtensionTestMatch;
export type NativeExtensionDeferredRegistrationFamily = ExtensionTestDeferredRegistrationFamily;
export type NativeExtensionDeferredRegistrationSummary = ExtensionTestDeferredRegistrationSummary;

const EMPTY_EXTENSION_REGISTRATIONS: ExtensionRegistrationSummary = {
  eventHooks: 0,
  agentRunHooks: 0,
  policyGates: 0,
  profileRouters: 0,
  inputSources: 0,
  reviewerPerspectives: 0,
  validationProviders: 0,
  tools: 0,
};

const DEFERRED_FAMILIES = [
  'agentRunHooks',
  'policyGates',
  'profileRouters',
  'inputSources',
  'reviewerPerspectives',
  'validationProviders',
  'tools',
] as const satisfies readonly ExtensionTestDeferredRegistrationFamily[];

type ReplayDiagnosticEvent = Extract<
  EforgeEvent,
  { type: 'extension:event-handler:failed' | 'extension:event-handler:timeout' }
>;

export async function parseExtensionEventFixtureFile(path: string): Promise<ExtensionEventFixtureParseResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    return invalidFixture(path, undefined, `Failed to read fixture: ${err instanceof Error ? err.message : String(err)}`);
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return invalidFixture(path, undefined, 'Fixture is empty');
  }

  const first = trimmed[0];
  if (first === '[') {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        return invalidFixture(path, 'json-array', 'JSON fixture beginning with [ must contain an array of events');
      }
      return validateFixtureEvents(path, 'json-array', parsed);
    } catch (err) {
      return invalidFixture(path, 'json-array', `Malformed JSON array fixture: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return validateFixtureEvents(path, 'json-array', parsed);
    return validateFixtureEvents(path, 'json', [parsed]);
  } catch (jsonErr) {
    const lines = raw.split(/\r?\n/).map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line.length > 0);
    const values: unknown[] = [];
    const diagnostics: ExtensionDiagnostic[] = [];
    for (const { line, index } of lines) {
      try {
        values.push(JSON.parse(line) as unknown);
      } catch (lineErr) {
        diagnostics.push(fixtureDiagnostic(
          path,
          `Malformed JSONL fixture on line ${index + 1}: ${lineErr instanceof Error ? lineErr.message : String(lineErr)}`,
        ));
      }
    }
    if (diagnostics.length > 0) {
      return { valid: false, path, format: 'jsonl', events: [], diagnostics };
    }
    if (values.length === 0) {
      return invalidFixture(path, 'jsonl', `Malformed JSON fixture: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
    }
    return validateFixtureEvents(path, 'jsonl', values);
  }
}

export async function replayNativeExtensionEvents(options: NativeExtensionReplayOptions): Promise<NativeExtensionReplayResult> {
  const selection = normalizeSelection(options);
  const loaderOptions = loaderOptionsForSelection(options.loaderOptions, selection);
  const loadResult = await loadNativeExtensions(loaderOptions);
  const registry = selectRegistry(loadResult.registry, selection);
  const inputEvents = options.events ?? [];
  const indexedEvents = inputEvents.map((event, index) => ({ event, index }));
  const filteredEvents = options.eventType
    ? indexedEvents.filter(({ event }) => event.type === options.eventType)
    : indexedEvents;
  const matches = computeMatches(registry.eventHooks, filteredEvents);

  const emittedDiagnostics: ReplayDiagnosticEvent[] = [];
  let emittedEventCount = 0;

  async function* replayEvents(): AsyncGenerator<EforgeEvent> {
    for (const { event } of filteredEvents) yield event;
  }

  for await (const emitted of withNativeEventHooks(replayEvents(), registry, {
    cwd: options.cwd,
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  })) {
    emittedEventCount += 1;
    if (emitted.type === 'extension:event-handler:failed' || emitted.type === 'extension:event-handler:timeout') {
      emittedDiagnostics.push(emitted);
    }
  }

  const staticDiagnostics = [
    ...loadResult.diagnostics.map(normalizeDiagnostic),
    ...selectionDiagnostics(registry, selection),
  ];
  const selectedStaticDiagnostics = [
    ...filterDiagnostics(staticDiagnostics, selection),
    ...(options.sourceDiagnostics ?? []),
  ];
  const extensions = projectExtensions(registry, loaderOptions.config.enabled);
  const replay: ExtensionTestReplayCounts = {
    inputEventCount: inputEvents.length,
    filteredEventCount: filteredEvents.length,
    emittedEventCount,
    diagnosticEventCount: emittedDiagnostics.length,
  };
  const valid = selectedStaticDiagnostics.every((diagnostic) => diagnostic.severity !== 'error')
    && emittedDiagnostics.length === 0;

  return {
    valid,
    source: options.source ?? { kind: 'none', ...(options.eventType !== undefined && { event: options.eventType }) },
    extensions,
    diagnostics: selectedStaticDiagnostics,
    replay,
    matches,
    emittedDiagnostics,
    deferredRegistrations: summarizeDeferredRegistrations(registry),
  };
}

export const testNativeExtensions = replayNativeExtensionEvents;

function normalizeSelection(
  options: Pick<NativeExtensionReplayOptions, 'loaderOptions' | 'name' | 'path'>,
): Pick<NativeExtensionReplayOptions, 'name' | 'path'> {
  return {
    ...(options.name !== undefined && { name: options.name }),
    ...(options.path !== undefined && { path: resolve(options.loaderOptions.cwd, options.path) }),
  };
}

function loaderOptionsForSelection(
  loaderOptions: NativeExtensionLoaderOptions,
  options: Pick<NativeExtensionReplayOptions, 'name' | 'path'>,
): NativeExtensionLoaderOptions {
  if (options.path) {
    return {
      ...loaderOptions,
      config: {
        ...loaderOptions.config,
        enabled: true,
        include: ['__eforge_no_auto_extensions__'],
        paths: [options.path],
      },
    };
  }
  if (!options.name) return loaderOptions;
  return {
    ...loaderOptions,
    config: {
      ...loaderOptions.config,
      include: [options.name],
      ...(loaderOptions.config.paths !== undefined && {
        paths: loaderOptions.config.paths.filter((configuredPath) => configuredPathName(configuredPath) === options.name),
      }),
    },
  };
}

const SUPPORTED_EXTENSION_SUFFIXES = new Set(['.ts', '.mts', '.js', '.mjs']);

function configuredPathName(path: string): string {
  const ext = extname(path);
  return SUPPORTED_EXTENSION_SUFFIXES.has(ext) ? basename(path, ext) : basename(path);
}

function validateFixtureEvents(path: string, format: ExtensionFixtureFormat, values: unknown[]): ExtensionEventFixtureParseResult {
  const events: EforgeEvent[] = [];
  const diagnostics: ExtensionDiagnostic[] = [];
  values.forEach((value, index) => {
    const parsed = safeParseEforgeEvent(value);
    if (parsed.success) {
      events.push(parsed.data);
      return;
    }
    diagnostics.push(fixtureDiagnostic(path, `Invalid event at index ${index}: ${parsed.error.message}`));
  });
  return { valid: diagnostics.length === 0, path, format, events: diagnostics.length === 0 ? events : [], diagnostics };
}

function invalidFixture(path: string, format: ExtensionFixtureFormat | undefined, message: string): ExtensionEventFixtureParseResult {
  return {
    valid: false,
    path,
    ...(format !== undefined && { format }),
    events: [],
    diagnostics: [fixtureDiagnostic(path, message)],
  };
}

function fixtureDiagnostic(path: string, message: string): ExtensionDiagnostic {
  return {
    severity: 'error',
    code: 'extension:invalid-fixture',
    message,
    path,
  };
}

function normalizeDiagnostic(diagnostic: NativeExtensionDiagnostic | ExtensionDiagnostic): ExtensionDiagnostic {
  const result: ExtensionDiagnostic = {
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
  };
  if (diagnostic.name !== undefined) result.name = diagnostic.name;
  if (diagnostic.path !== undefined) result.path = diagnostic.path;
  if (diagnostic.scope !== undefined) result.scope = diagnostic.scope as ExtensionDiagnostic['scope'];
  if (diagnostic.source !== undefined) result.source = diagnostic.source;
  const trustHashes = diagnostic as { currentHash?: string; trustedHash?: string };
  const resultWithTrustHashes = result as ExtensionDiagnostic & { currentHash?: string; trustedHash?: string };
  if (trustHashes.currentHash !== undefined) resultWithTrustHashes.currentHash = trustHashes.currentHash;
  if (trustHashes.trustedHash !== undefined) resultWithTrustHashes.trustedHash = trustHashes.trustedHash;
  return result;
}

function selectionDiagnostics(
  registry: NativeExtensionRegistry,
  options: Pick<NativeExtensionReplayOptions, 'name' | 'path'>,
): ExtensionDiagnostic[] {
  if ((!options.name && !options.path) || registry.candidates.length > 0) return [];
  return [{
    severity: 'error',
    code: 'extension:not-found',
    message: options.name ? `Extension not found: ${options.name}` : `Extension path not found: ${options.path}`,
    ...(options.name !== undefined && { name: options.name }),
    ...(options.path !== undefined && { path: options.path }),
  }];
}

function filterDiagnostics(diagnostics: ExtensionDiagnostic[], options: Pick<NativeExtensionReplayOptions, 'name' | 'path'>): ExtensionDiagnostic[] {
  if (!options.name && !options.path) return diagnostics;
  return diagnostics.filter((diagnostic) => {
    if (options.name && diagnostic.name === options.name) return true;
    if (options.path && diagnostic.path === options.path) return true;
    if (!diagnostic.name && !diagnostic.path) return true;
    return false;
  });
}

function selectRegistry(registry: NativeExtensionRegistry, options: Pick<NativeExtensionReplayOptions, 'name' | 'path'>): NativeExtensionRegistry {
  if (!options.name && !options.path) return registry;
  const matches = (entry: { extensionName: string; extensionPath: string }): boolean => {
    if (options.name && entry.extensionName !== options.name) return false;
    if (options.path && entry.extensionPath !== options.path) return false;
    return true;
  };
  const matchesCandidate = (candidate: NativeExtensionCandidate): boolean => {
    if (options.name && candidate.name !== options.name) return false;
    if (options.path && candidate.path !== options.path && candidate.entrypoint !== options.path) return false;
    return true;
  };

  return {
    extensions: registry.extensions.filter((extension) => matches({ extensionName: extension.name, extensionPath: extension.path })),
    candidates: registry.candidates.filter(matchesCandidate),
    eventHooks: registry.eventHooks.filter(matches),
    agentRunHooks: registry.agentRunHooks.filter(matches),
    policyGates: registry.policyGates.filter(matches),
    profileRouters: registry.profileRouters.filter(matches),
    inputSources: registry.inputSources.filter(matches),
    reviewerPerspectives: registry.reviewerPerspectives.filter(matches),
    validationProviders: registry.validationProviders.filter(matches),
    tools: registry.tools.filter(matches),
    diagnostics: registry.diagnostics.filter((diagnostic) => {
      if (options.name && diagnostic.name !== options.name) return false;
      if (options.path && diagnostic.path !== options.path) return false;
      return true;
    }),
  };
}

function computeMatches(
  hooks: EventHookRegistration[],
  events: Array<{ event: EforgeEvent; index: number }>,
): ExtensionTestMatch[] {
  const compiled = hooks.map((registration) => ({ registration, regex: compilePattern(registration.value.pattern) }));
  const matches: ExtensionTestMatch[] = [];
  for (const { event, index } of events) {
    for (const { registration, regex } of compiled) {
      if (!regex.test(event.type)) continue;
      matches.push({
        eventIndex: index,
        eventType: event.type,
        extensionName: registration.extensionName,
        extensionPath: registration.extensionPath,
        pattern: registration.value.pattern,
      });
    }
  }
  return matches;
}

function projectExtensions(registry: NativeExtensionRegistry, globalEnabled: boolean): ExtensionEntry[] {
  const loadedByKey = new Map(registry.extensions.map((extension) => [`${extension.name}\0${extension.path}`, extension]));
  return registry.candidates.map((candidate) => {
    const loaded = loadedByKey.get(`${candidate.name}\0${candidate.path}`);
    return {
      name: candidate.name,
      path: candidate.path,
      ...(candidate.entrypoint !== undefined && { entrypoint: candidate.entrypoint }),
      scope: candidate.scope as ExtensionEntry['scope'],
      source: candidate.source,
      status: candidate.status as ExtensionEntry['status'],
      enabled: globalEnabled && candidate.status !== 'shadowed',
      trust: candidate.trust,
      ...(candidate.trustState !== undefined && { trustState: candidate.trustState }),
      ...(candidate.currentHash !== undefined && { currentHash: candidate.currentHash }),
      ...(candidate.trustedHash !== undefined && { trustedHash: candidate.trustedHash }),
      ...(candidate.trustedAt !== undefined && { trustedAt: candidate.trustedAt }),
      ...(candidate.trustedBy !== undefined && { trustedBy: candidate.trustedBy }),
      ...(candidate.trustStorePath !== undefined && { trustStorePath: candidate.trustStorePath }),
      ...(candidate.format !== undefined && { format: candidate.format }),
      ...(candidate.layout !== undefined && { layout: candidate.layout }),
      ...(loaded?.strategy !== undefined && { strategy: loaded.strategy }),
      shadows: candidate.shadows.map((shadow) => ({
        name: shadow.name,
        path: shadow.path,
        ...(shadow.entrypoint !== undefined && { entrypoint: shadow.entrypoint }),
        scope: shadow.scope,
        ...(shadow.format !== undefined && { format: shadow.format }),
        ...(shadow.layout !== undefined && { layout: shadow.layout }),
      })),
      registrations: loaded?.registrations ?? { ...EMPTY_EXTENSION_REGISTRATIONS },
      diagnostics: candidate.diagnostics.map(normalizeDiagnostic),
    } satisfies ExtensionEntry;
  }).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

function summarizeDeferredRegistrations(registry: NativeExtensionRegistry): ExtensionTestDeferredRegistrationSummary[] {
  return DEFERRED_FAMILIES.map((family) => {
    const registrations = registry[family];
    const grouped = new Map<string, { name: string; path: string; count: number }>();
    for (const registration of registrations) {
      const key = `${registration.extensionName}\0${registration.extensionPath}`;
      const current = grouped.get(key) ?? { name: registration.extensionName, path: registration.extensionPath, count: 0 };
      current.count += 1;
      grouped.set(key, current);
    }
    const extensions = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return {
      family,
      count: registrations.length,
      extensions,
    };
  });
}
