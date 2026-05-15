import type { Scope } from '@eforge-build/scopes';

export type EventPattern = string;
export type ExtensionHandler = (...args: never[]) => unknown;
export interface ProfileRouterSpec { name: string; selectBuildProfile?: ExtensionHandler; resolve?: ExtensionHandler }
export interface InputSourceAdapter { name: string; description: string; fetch: ExtensionHandler }
export interface ReviewerPerspectiveSpec { key: string; label: string; promptFragment: string }
export interface ValidationProviderSpec { name: string; description: string; validate: ExtensionHandler }
export interface ExtensionTool { name: string; description: string; inputSchema: object; handler: ExtensionHandler }
export interface EforgeExtensionAPIShape {
  onEvent(pattern: EventPattern, handler: ExtensionHandler): void;
  onAgentRun(handler: ExtensionHandler): void;
  beforePlanMerge(handler: ExtensionHandler): void;
  registerProfileRouter(spec: ProfileRouterSpec): void;
  registerInputSource(adapter: InputSourceAdapter): void;
  registerReviewerPerspective(spec: ReviewerPerspectiveSpec): void;
  registerValidationProvider(spec: ValidationProviderSpec): void;
  registerTool(tool: ExtensionTool): void;
}
export type EforgeExtensionFactoryShape = (api: EforgeExtensionAPIShape) => void | Promise<void>;

export type NativeExtensionSource = 'auto' | 'explicit';
export type NativeExtensionScope = Scope | 'external';
export type NativeExtensionTrust = 'trusted' | 'untrusted';
export type NativeExtensionStatus = 'pending' | 'shadowed' | 'loaded' | 'skipped' | 'error';
export type NativeExtensionFormat = 'js' | 'mjs' | 'ts' | 'mts';
export type NativeExtensionLayout = 'file' | 'directory';
export type NativeExtensionLoaderStrategy = 'dynamic-import' | 'jiti';
export type NativeExtensionDiagnosticSeverity = 'warning' | 'error';

export interface NativeExtensionDiagnostic {
  severity: NativeExtensionDiagnosticSeverity;
  code: string;
  message: string;
  name?: string;
  path?: string;
  scope?: NativeExtensionScope;
  source?: NativeExtensionSource;
}

export interface NativeExtensionShadow {
  name: string;
  path: string;
  entrypoint?: string;
  scope: Scope;
  format?: NativeExtensionFormat;
  layout?: NativeExtensionLayout;
}

export interface NativeExtensionCandidate {
  name: string;
  path: string;
  entrypoint?: string;
  scope: NativeExtensionScope;
  source: NativeExtensionSource;
  format?: NativeExtensionFormat;
  layout?: NativeExtensionLayout;
  trust: NativeExtensionTrust;
  status: NativeExtensionStatus;
  shadows: NativeExtensionShadow[];
  diagnostics: NativeExtensionDiagnostic[];
}

export interface NativeExtensionDiscoveryResult {
  candidates: NativeExtensionCandidate[];
  diagnostics: NativeExtensionDiagnostic[];
}

export interface BaseExtensionRegistration<TKind extends string, TValue> {
  kind: TKind;
  extensionName: string;
  extensionPath: string;
  value: TValue;
}

export type EventHookRegistration = BaseExtensionRegistration<'eventHook', {
  pattern: EventPattern;
  handler: ExtensionHandler;
}>;
export type AgentRunRegistration = BaseExtensionRegistration<'agentRunHook', ExtensionHandler>;
export type PolicyGateRegistration = BaseExtensionRegistration<'policyGate', ExtensionHandler>;
export type ProfileRouterRegistration = BaseExtensionRegistration<'profileRouter', ProfileRouterSpec> & { name: string };
export type InputSourceRegistration = BaseExtensionRegistration<'inputSource', InputSourceAdapter> & { name: string };
export type ReviewerPerspectiveRegistration = BaseExtensionRegistration<'reviewerPerspective', ReviewerPerspectiveSpec> & { name: string };
export type ValidationProviderRegistration = BaseExtensionRegistration<'validationProvider', ValidationProviderSpec> & { name: string };
export type ToolRegistration = BaseExtensionRegistration<'tool', ExtensionTool> & { name: string };

export interface NativeExtensionRecorderState {
  eventHooks: EventHookRegistration[];
  agentRunHooks: AgentRunRegistration[];
  policyGates: PolicyGateRegistration[];
  profileRouters: ProfileRouterRegistration[];
  inputSources: InputSourceRegistration[];
  reviewerPerspectives: ReviewerPerspectiveRegistration[];
  validationProviders: ValidationProviderRegistration[];
  tools: ToolRegistration[];
  diagnostics: NativeExtensionDiagnostic[];
}

export interface LoadedNativeExtension {
  name: string;
  path: string;
  entrypoint: string;
  scope: NativeExtensionScope;
  source: NativeExtensionSource;
  strategy: NativeExtensionLoaderStrategy;
  registrations: {
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

export interface NativeExtensionRegistry extends NativeExtensionRecorderState {
  extensions: LoadedNativeExtension[];
  candidates: NativeExtensionCandidate[];
}

export interface NativeExtensionLoadResult {
  registry: NativeExtensionRegistry;
  diagnostics: NativeExtensionDiagnostic[];
  candidates: NativeExtensionCandidate[];
}

export interface NativeExtensionLoaderOptions {
  cwd: string;
  configDir: string;
  config: {
    enabled: boolean;
    trustProjectExtensions: boolean;
    include?: string[];
    exclude?: string[];
    paths?: string[];
  };
}
