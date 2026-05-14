import type {
  EforgeExtensionAPIShape,
  EventPattern,
  ExtensionHandler,
  ExtensionTool,
  InputSourceAdapter,
  NativeExtensionDiagnostic,
  NativeExtensionRecorderState,
  ProfileRouterSpec,
  ReviewerPerspectiveSpec,
  ValidationProviderSpec,
} from './types.js';

export function createExtensionRecorder(extensionName: string, extensionPath: string): {
  api: EforgeExtensionAPIShape;
  state: NativeExtensionRecorderState;
} {
  const state: NativeExtensionRecorderState = {
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

  const addDiagnostic = (message: string, code = 'extension:invalid-registration', name?: string): void => {
    state.diagnostics.push({
      severity: 'error',
      code,
      message,
      name,
      path: extensionPath,
    });
  };

  const api: EforgeExtensionAPIShape = {
    onEvent(pattern: EventPattern, handler: unknown): void {
      if (!isNonEmptyString(pattern)) {
        addDiagnostic('onEvent requires a non-empty string pattern');
        return;
      }
      if (typeof handler !== 'function') {
        addDiagnostic(`onEvent("${pattern}") requires a handler function`);
        return;
      }
      state.eventHooks.push({
        kind: 'eventHook',
        extensionName,
        extensionPath,
        value: { pattern, handler: handler as ExtensionHandler },
      });
    },
    onAgentRun(handler: unknown): void {
      if (typeof handler !== 'function') {
        addDiagnostic('onAgentRun requires a handler function');
        return;
      }
      state.agentRunHooks.push({ kind: 'agentRunHook', extensionName, extensionPath, value: handler as ExtensionHandler });
    },
    beforePlanMerge(handler: unknown): void {
      if (typeof handler !== 'function') {
        addDiagnostic('beforePlanMerge requires a handler function');
        return;
      }
      state.policyGates.push({ kind: 'policyGate', extensionName, extensionPath, value: handler as ExtensionHandler });
    },
    registerProfileRouter(spec: unknown): void {
      if (!isObject(spec) || !isNonEmptyString(spec.name) || typeof spec.resolve !== 'function') {
        addDiagnostic('registerProfileRouter requires { name: string, resolve: function }', 'extension:invalid-registration', isObject(spec) && typeof spec.name === 'string' ? spec.name : undefined);
        return;
      }
      state.profileRouters.push({ kind: 'profileRouter', extensionName, extensionPath, name: spec.name, value: spec as unknown as ProfileRouterSpec });
    },
    registerInputSource(adapter: unknown): void {
      if (!isObject(adapter) || !isNonEmptyString(adapter.name) || !isNonEmptyString(adapter.description) || typeof adapter.fetch !== 'function') {
        addDiagnostic('registerInputSource requires { name: string, description: string, fetch: function }', 'extension:invalid-registration', isObject(adapter) && typeof adapter.name === 'string' ? adapter.name : undefined);
        return;
      }
      state.inputSources.push({ kind: 'inputSource', extensionName, extensionPath, name: adapter.name, value: adapter as unknown as InputSourceAdapter });
    },
    registerReviewerPerspective(spec: unknown): void {
      if (!isObject(spec) || !isNonEmptyString(spec.key) || !isNonEmptyString(spec.label) || !isNonEmptyString(spec.promptFragment)) {
        addDiagnostic('registerReviewerPerspective requires { key: string, label: string, promptFragment: string }', 'extension:invalid-registration', isObject(spec) && typeof spec.key === 'string' ? spec.key : undefined);
        return;
      }
      state.reviewerPerspectives.push({ kind: 'reviewerPerspective', extensionName, extensionPath, name: spec.key, value: spec as unknown as ReviewerPerspectiveSpec });
    },
    registerValidationProvider(spec: unknown): void {
      if (!isObject(spec) || !isNonEmptyString(spec.name) || !isNonEmptyString(spec.description) || typeof spec.validate !== 'function') {
        addDiagnostic('registerValidationProvider requires { name: string, description: string, validate: function }', 'extension:invalid-registration', isObject(spec) && typeof spec.name === 'string' ? spec.name : undefined);
        return;
      }
      state.validationProviders.push({ kind: 'validationProvider', extensionName, extensionPath, name: spec.name, value: spec as unknown as ValidationProviderSpec });
    },
    registerTool(tool: unknown): void {
      if (!isObject(tool) || !isNonEmptyString(tool.name) || !isNonEmptyString(tool.description) || !isObject(tool.inputSchema) || typeof tool.handler !== 'function') {
        addDiagnostic('registerTool requires { name: string, description: string, inputSchema: object, handler: function }', 'extension:invalid-registration', isObject(tool) && typeof tool.name === 'string' ? tool.name : undefined);
        return;
      }
      state.tools.push({ kind: 'tool', extensionName, extensionPath, name: tool.name, value: tool as unknown as ExtensionTool });
    },
  };

  return { api, state };
}

export function mergeRecorderState(target: NativeExtensionRecorderState, source: NativeExtensionRecorderState): NativeExtensionDiagnostic[] {
  const diagnostics: NativeExtensionDiagnostic[] = [];
  target.eventHooks.push(...source.eventHooks);
  target.agentRunHooks.push(...source.agentRunHooks);
  target.policyGates.push(...source.policyGates);
  target.diagnostics.push(...source.diagnostics);
  diagnostics.push(...source.diagnostics);

  mergeNamedRegistrations(target.profileRouters, source.profileRouters, 'profile router', diagnostics, target.diagnostics);
  mergeNamedRegistrations(target.inputSources, source.inputSources, 'input source', diagnostics, target.diagnostics);
  mergeNamedRegistrations(target.reviewerPerspectives, source.reviewerPerspectives, 'reviewer perspective', diagnostics, target.diagnostics);
  mergeNamedRegistrations(target.validationProviders, source.validationProviders, 'validation provider', diagnostics, target.diagnostics);
  mergeNamedRegistrations(target.tools, source.tools, 'tool', diagnostics, target.diagnostics);
  return diagnostics;
}

function mergeNamedRegistrations<T extends { name: string; extensionName: string; extensionPath: string }>(
  target: T[],
  source: T[],
  label: string,
  diagnostics: NativeExtensionDiagnostic[],
  allDiagnostics: NativeExtensionDiagnostic[],
): void {
  const existing = new Map(target.map((entry) => [entry.name, entry]));
  for (const registration of source) {
    const duplicate = existing.get(registration.name);
    if (duplicate) {
      const diagnostic: NativeExtensionDiagnostic = {
        severity: 'error',
        code: 'extension:duplicate-registration',
        message: `Duplicate ${label} name "${registration.name}" from extension "${registration.extensionName}" conflicts with extension "${duplicate.extensionName}"`,
        name: registration.name,
        path: registration.extensionPath,
      };
      diagnostics.push(diagnostic);
      allDiagnostics.push(diagnostic);
      continue;
    }
    target.push(registration);
    existing.set(registration.name, registration);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
