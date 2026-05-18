import type { Scope } from '@eforge-build/scopes';

export type EventPattern = string;
export type ExtensionHandler = (...args: never[]) => unknown;
export interface ProfileRouterSpec { name: string; selectBuildProfile?: ExtensionHandler; resolve?: ExtensionHandler }
export interface InputSourceAdapter { name: string; description: string; fetch: ExtensionHandler }
export interface ReviewerPerspectiveSpec { key: string; label: string; promptFragment: string }
export interface ValidationProviderSpec { name: string; description: string; validate: ExtensionHandler }
export interface ExtensionTool { name: string; description: string; inputSchema: object; handler: ExtensionHandler }
export type PolicyGateKind = 'queue-dispatch' | 'plan-merge' | 'final-merge';
export type PolicyGateMethod = 'beforeQueueDispatch' | 'beforePlanMerge' | 'beforeFinalMerge';
export interface EforgeExtensionAPIShape {
  onEvent(pattern: EventPattern, handler: ExtensionHandler): void;
  onAgentRun(handler: ExtensionHandler): void;
  beforeQueueDispatch(handler: ExtensionHandler): void;
  beforePlanMerge(handler: ExtensionHandler): void;
  beforeFinalMerge(handler: ExtensionHandler): void;
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
/**
 * Richer trust state for native extensions.
 *
 * - `not-required` — user, project-local, or external path; no project/team trust gate applies.
 * - `untrusted`    — project-team candidate with no matching trust record.
 * - `trusted`      — project-team candidate whose current hash matches the stored trust record.
 * - `changed`      — project-team candidate that was previously trusted but whose content has changed.
 */
export type NativeExtensionTrustState = 'not-required' | 'untrusted' | 'trusted' | 'changed';
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
  /** Current content hash (included in trust-related diagnostics for project-team extensions). */
  currentHash?: string;
  /** Trusted hash from the trust record (included in `extension:trust-changed` diagnostics). */
  trustedHash?: string;
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
  /** Backward-compatible coarse trust: `'trusted'` or `'untrusted'`. See `trustState` for richer classification. */
  trust: NativeExtensionTrust;
  /**
   * Richer trust classification set during discovery.
   * - `not-required` for user, project-local, and external candidates.
   * - `untrusted`, `trusted`, or `changed` for project-team candidates.
   */
  trustState?: NativeExtensionTrustState;
  /** SHA-256 hash of the extension content computed at discovery time (project-team candidates only). */
  currentHash?: string;
  /** SHA-256 hash stored in the trust record at the time the extension was trusted (if a record exists). */
  trustedHash?: string;
  /** ISO-8601 timestamp from the trust record (if a record exists). */
  trustedAt?: string;
  /** Optional annotation from the trust record identifying who trusted the extension. */
  trustedBy?: string;
  /** Absolute path to the trust store file that was consulted during discovery. */
  trustStorePath?: string;
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
export type PolicyGateRegistration = BaseExtensionRegistration<'policyGate', ExtensionHandler> & {
  gateKind: PolicyGateKind;
  method: PolicyGateMethod;
  registrationIndex: number;
};
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
