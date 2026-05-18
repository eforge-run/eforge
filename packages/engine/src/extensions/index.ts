// --- eforge:region plan-01-engine-trust-foundation ---
export { hashExtensionDirectory, hashExtensionFile } from './hash.js';
export {
  getTrustRecord,
  getTrustStorePath,
  readTrustStore,
  removeTrustRecord,
  upsertTrustRecord,
  writeTrustStore,
  TRUST_STORE_FILENAME,
} from './trust-store.js';
export type { ExtensionTrustRecord, ExtensionTrustStore } from './trust-store.js';
// --- eforge:endregion plan-01-engine-trust-foundation ---
export type {
  NativeExtensionCandidate,
  NativeExtensionDiagnostic,
  NativeExtensionDiscoveryResult,
  NativeExtensionFormat,
  NativeExtensionLayout,
  NativeExtensionLoaderOptions,
  NativeExtensionLoaderStrategy,
  NativeExtensionLoadResult,
  NativeExtensionRegistry,
  NativeExtensionScope,
  NativeExtensionShadow,
  NativeExtensionSource,
  NativeExtensionStatus,
  NativeExtensionTrust,
  NativeExtensionTrustState,
  LoadedNativeExtension,
  EventHookRegistration,
  AgentRunRegistration,
  PolicyGateKind,
  PolicyGateMethod,
  PolicyGateRegistration,
  ProfileRouterRegistration,
  InputSourceRegistration,
  ReviewerPerspectiveRegistration,
  ValidationProviderRegistration,
  ToolRegistration,
} from './types.js';
export { discoverNativeExtensions } from './discovery.js';
export { createExtensionRecorder, mergeRecorderState } from './recorder.js';
export { loadNativeExtensions } from './loader.js';
export {
  DEFAULT_EVENT_HOOK_DRAIN_GRACE_MS,
  DEFAULT_EVENT_HOOK_EXEC_OUTPUT_LIMIT_BYTES,
  DEFAULT_NATIVE_EVENT_HOOK_TIMEOUT_MS,
  withNativeEventHooks,
} from './event-runtime.js';
export type {
  EventHookContext,
  EventHookExecOptions,
  EventHookExecResult,
  NativeEventHookRuntimeOptions,
} from './event-runtime.js';
// --- eforge:region plan-01-agent-context-runtime ---
export {
  withAgentContextHooks,
  executeAgentRunHooks,
} from './agent-context-runtime.js';
export type {
  AgentContextHookRuntimeOptions,
  AgentRunHooksExecutionResult,
} from './agent-context-runtime.js';
// --- eforge:endregion plan-01-agent-context-runtime ---
// --- eforge:region plan-02-runtime-and-integration ---
export {
  executeProfileRouters,
  buildProfileRouterContext,
} from './profile-router-runtime.js';
export type {
  RouterSelection,
  ProfileRouterExecutionResult,
  ExecuteProfileRoutersOptions,
  BuildProfileRouterContextDeps,
} from './profile-router-runtime.js';
// --- eforge:endregion plan-02-runtime-and-integration ---
// --- eforge:region plan-01-policy-gate-foundation ---
export {
  buildFinalMergePolicyGateContext,
  buildPlanMergePolicyGateContext,
  buildPolicyGateContext,
  buildQueueDispatchPolicyGateContext,
  executePolicyGate,
  validatePolicyDecision,
} from './policy-gate-runtime.js';
export type {
  AnyPolicyGateContext,
  ExecutePolicyGateOptions,
  FinalMergePolicyGateContext,
  FinalMergePolicyGateTarget,
  PlanMergePolicyGateContext,
  PlanMergePolicyGateTarget,
  PolicyGateContextHelpersOptions,
  PolicyGateDecisionKind,
  PolicyGateExecutionResult,
  PolicyGateFailurePolicy,
  PolicyGateTarget,
  QueueDispatchPolicyGateContext,
  QueueDispatchPolicyGateTarget,
} from './policy-gate-runtime.js';
// --- eforge:endregion plan-01-policy-gate-foundation ---
export type { NativeExtensionRegistryProjection } from './projector.js';
export { projectExtensionRegistry } from './projector.js';
// --- eforge:region plan-01-engine-daemon-extension-replay ---
export {
  parseExtensionEventFixtureFile,
  replayNativeExtensionEvents,
  testNativeExtensions,
} from './replay.js';
export type {
  ExtensionEventFixtureParseResult,
  ExtensionFixtureFormat,
  NativeExtensionDeferredRegistrationFamily,
  NativeExtensionDeferredRegistrationSummary,
  NativeExtensionReplayCounts,
  NativeExtensionReplayMatch,
  NativeExtensionReplayOptions,
  NativeExtensionReplayResult,
  NativeExtensionReplaySource,
} from './replay.js';
// --- eforge:endregion plan-01-engine-daemon-extension-replay ---
// --- eforge:region plan-01-extension-management-api ---
export {
  SUPPORTED_EXTENSION_SCAFFOLD_TEMPLATES,
  ScaffoldNativeExtensionError,
  scaffoldNativeExtension,
} from './scaffold.js';
export type {
  ExtensionScaffoldErrorCode,
  ExtensionScaffoldRequestScope,
  ExtensionScaffoldTemplate,
  ScaffoldNativeExtensionOptions,
  ScaffoldNativeExtensionResult,
} from './scaffold.js';
// --- eforge:endregion plan-01-extension-management-api ---
