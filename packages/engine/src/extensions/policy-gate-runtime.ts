import { execFile } from 'node:child_process';
import type { EforgeEvent } from '../events.js';
import type { NativeExtensionRegistry, PolicyGateKind, PolicyGateRegistration } from './types.js';

export type PolicyGateFailurePolicy = 'fail-open' | 'fail-closed';
export type PolicyGateDecisionKind = 'allow' | 'block' | 'require-approval';

interface ExtensionDiffMirror {
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
  }>;
}

interface PolicyDecisionMirror {
  decision: PolicyGateDecisionKind;
  reason?: string;
}

interface PolicyGateContextBase {
  gateKind: PolicyGateKind;
  logger: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  exec: {
    run(
      command: string,
      args?: string[],
      options?: { cwd?: string; env?: Record<string, string> },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
}

export interface QueueDispatchPolicyGateContext extends PolicyGateContextBase {
  gateKind: 'queue-dispatch';
  prdId: string;
  prdTitle?: string;
  priority?: number;
  dependsOn: string[];
}

export interface PlanMergePolicyGateContext extends PolicyGateContextBase {
  gateKind: 'plan-merge';
  planId: string;
  diff: ExtensionDiffMirror;
}

export interface FinalMergePolicyGateContext extends PolicyGateContextBase {
  gateKind: 'final-merge';
  featureBranch: string;
  baseBranch: string;
  planIds?: string[];
  diff: ExtensionDiffMirror;
}

export type AnyPolicyGateContext =
  | QueueDispatchPolicyGateContext
  | PlanMergePolicyGateContext
  | FinalMergePolicyGateContext;

export interface QueueDispatchPolicyGateTarget {
  prdId: string;
  prdTitle?: string;
  priority?: number;
  dependsOn?: string[];
}

export interface PlanMergePolicyGateTarget {
  planId: string;
  diff: ExtensionDiffMirror;
}

export interface FinalMergePolicyGateTarget {
  featureBranch: string;
  baseBranch: string;
  planIds?: string[];
  diff: ExtensionDiffMirror;
}

export type PolicyGateTarget =
  | ({ gateKind: 'queue-dispatch' } & QueueDispatchPolicyGateTarget)
  | ({ gateKind: 'plan-merge' } & PlanMergePolicyGateTarget)
  | ({ gateKind: 'final-merge' } & FinalMergePolicyGateTarget);

export interface PolicyGateContextHelpersOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExecutePolicyGateOptions {
  registry?: Pick<NativeExtensionRegistry, 'policyGates'> | null;
  gateKind: PolicyGateKind;
  context: AnyPolicyGateContext;
  timeoutMs: number;
  failurePolicy: PolicyGateFailurePolicy;
}

export interface PolicyGateExecutionResult {
  decision: PolicyDecisionMirror;
  blocked: boolean;
  events: EforgeEvent[];
}

type PolicyHandler = (ctx: AnyPolicyGateContext) => unknown;
type PolicyDiagnosticEvent = Extract<EforgeEvent, {
  type: 'extension:policy:decision' | 'extension:policy:failed' | 'extension:policy:timeout';
}>;
type PolicyDecisionEvent = Extract<EforgeEvent, { type: 'extension:policy:decision' }>;
type PolicyFailedEvent = Extract<EforgeEvent, { type: 'extension:policy:failed' }>;
type PolicyTimeoutEvent = Extract<EforgeEvent, { type: 'extension:policy:timeout' }>;

type TargetIdentifiers =
  | { prdId: string; prdTitle?: string }
  | { planId: string }
  | { featureBranch: string; baseBranch: string; planIds?: string[] };

const MUTATION_SHAPED_KEYS = new Set([
  'modify',
  'modification',
  'modifications',
  'mutation',
  'mutations',
  'patch',
  'patches',
  'change',
  'changes',
  'update',
  'updates',
]);

function createLogger(gateKind: PolicyGateKind, extensionName?: string) {
  const prefix = extensionName
    ? `[eforge ext:${extensionName} policy:${gateKind}]`
    : `[eforge policy:${gateKind}]`;
  return {
    debug: (message: string) => process.stderr.write(`${prefix} debug: ${message}\n`),
    info: (message: string) => process.stderr.write(`${prefix} info: ${message}\n`),
    warn: (message: string) => process.stderr.write(`${prefix} warn: ${message}\n`),
    error: (message: string) => process.stderr.write(`${prefix} error: ${message}\n`),
  };
}

function createExec(cwd: string, env: NodeJS.ProcessEnv) {
  return {
    run: async (
      command: string,
      args: string[] = [],
      options?: { cwd?: string; env?: Record<string, string> },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd: options?.cwd ?? cwd,
          env: options?.env ? { ...env, ...options.env } : env,
        },
        (error, stdout, stderr) => {
          if (error) {
            const exitCode = typeof error.code === 'number' ? error.code : 1;
            resolve({ stdout: stdout || '', stderr: stderr || error.message, exitCode });
            return;
          }
          resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: 0 });
        },
      );
    }),
  };
}

function makeHelpers(gateKind: PolicyGateKind, options: PolicyGateContextHelpersOptions, extensionName?: string) {
  return {
    logger: createLogger(gateKind, extensionName),
    exec: createExec(options.cwd ?? process.cwd(), options.env ?? process.env),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === 'object' && !Object.isFrozen(child)) {
        deepFreeze(child);
      }
    }
  }
  return value;
}

function cloneDiff(diff: ExtensionDiffMirror): ExtensionDiffMirror {
  return { files: diff.files.map((file) => ({ ...file })) };
}

export function buildQueueDispatchPolicyGateContext(
  target: QueueDispatchPolicyGateTarget,
  options: PolicyGateContextHelpersOptions = {},
): QueueDispatchPolicyGateContext {
  return deepFreeze({
    gateKind: 'queue-dispatch' as const,
    prdId: target.prdId,
    ...(target.prdTitle !== undefined && { prdTitle: target.prdTitle }),
    ...(target.priority !== undefined && { priority: target.priority }),
    dependsOn: [...(target.dependsOn ?? [])],
    ...makeHelpers('queue-dispatch', options),
  });
}

export function buildPlanMergePolicyGateContext(
  target: PlanMergePolicyGateTarget,
  options: PolicyGateContextHelpersOptions = {},
): PlanMergePolicyGateContext {
  return deepFreeze({
    gateKind: 'plan-merge' as const,
    planId: target.planId,
    diff: cloneDiff(target.diff),
    ...makeHelpers('plan-merge', options),
  });
}

export function buildFinalMergePolicyGateContext(
  target: FinalMergePolicyGateTarget,
  options: PolicyGateContextHelpersOptions = {},
): FinalMergePolicyGateContext {
  return deepFreeze({
    gateKind: 'final-merge' as const,
    featureBranch: target.featureBranch,
    baseBranch: target.baseBranch,
    ...(target.planIds !== undefined && { planIds: [...target.planIds] }),
    diff: cloneDiff(target.diff),
    ...makeHelpers('final-merge', options),
  });
}

export function buildPolicyGateContext(
  target: PolicyGateTarget,
  options: PolicyGateContextHelpersOptions = {},
): AnyPolicyGateContext {
  if (target.gateKind === 'queue-dispatch') {
    return buildQueueDispatchPolicyGateContext(target, options);
  }
  if (target.gateKind === 'plan-merge') {
    return buildPlanMergePolicyGateContext(target, options);
  }
  return buildFinalMergePolicyGateContext(target, options);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function targetIdentifiers(context: AnyPolicyGateContext): TargetIdentifiers {
  if (context.gateKind === 'queue-dispatch') {
    return {
      prdId: context.prdId,
      ...(context.prdTitle !== undefined && { prdTitle: context.prdTitle }),
    };
  }
  if (context.gateKind === 'plan-merge') {
    return { planId: context.planId };
  }
  return {
    featureBranch: context.featureBranch,
    baseBranch: context.baseBranch,
    ...(context.planIds !== undefined && { planIds: [...context.planIds] }),
  };
}

function baseEventFields(
  registration: PolicyGateRegistration,
  context: AnyPolicyGateContext,
  failurePolicy: PolicyGateFailurePolicy,
) {
  return {
    timestamp: new Date().toISOString(),
    extensionName: registration.extensionName,
    extensionPath: registration.extensionPath,
    gateKind: registration.gateKind,
    method: registration.method,
    registrationIndex: registration.registrationIndex,
    failurePolicy,
    ...targetIdentifiers(context),
  };
}

function hasMutationShape(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => MUTATION_SHAPED_KEYS.has(key));
}

export function validatePolicyDecision(value: unknown): PolicyDecisionMirror {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Policy gate must return an object policy decision');
  }
  const object = value as Record<string, unknown>;
  if (hasMutationShape(object)) {
    throw new Error('Policy gate returned a mutation-shaped object; policy gates may only allow, block, or require approval');
  }
  if (object.decision === 'allow') {
    return { decision: 'allow' };
  }
  if (object.decision === 'block' || object.decision === 'require-approval') {
    if (typeof object.reason !== 'string' || object.reason.trim().length === 0) {
      throw new Error(`Policy gate decision "${object.decision}" requires a non-empty reason`);
    }
    return { decision: object.decision, reason: object.reason };
  }
  throw new Error('Policy gate returned an invalid decision');
}

function makeDecisionEvent(
  registration: PolicyGateRegistration,
  context: AnyPolicyGateContext,
  failurePolicy: PolicyGateFailurePolicy,
  decision: PolicyDecisionMirror,
): PolicyDecisionEvent {
  return {
    type: 'extension:policy:decision',
    ...baseEventFields(registration, context, failurePolicy),
    decision: decision.decision,
    ...(decision.reason !== undefined && { reason: decision.reason }),
  } as PolicyDecisionEvent;
}

function makeFailedEvent(
  registration: PolicyGateRegistration,
  context: AnyPolicyGateContext,
  failurePolicy: PolicyGateFailurePolicy,
  error: unknown,
): PolicyFailedEvent {
  const stack = errorStack(error);
  return {
    type: 'extension:policy:failed',
    ...baseEventFields(registration, context, failurePolicy),
    message: errorMessage(error),
    ...(stack !== undefined && { stack }),
  } as PolicyFailedEvent;
}

function makeTimeoutEvent(
  registration: PolicyGateRegistration,
  context: AnyPolicyGateContext,
  failurePolicy: PolicyGateFailurePolicy,
  timeoutMs: number,
): PolicyTimeoutEvent {
  return {
    type: 'extension:policy:timeout',
    ...baseEventFields(registration, context, failurePolicy),
    timeoutMs,
  } as PolicyTimeoutEvent;
}

function executeHandlerWithTimeout(
  registration: PolicyGateRegistration,
  context: AnyPolicyGateContext,
  timeoutMs: number,
): Promise<{ result: unknown } | { timedOut: true } | { error: unknown }> {
  const handler = registration.value as unknown as PolicyHandler;
  let timedOut = false;

  const handlerPromise = Promise.resolve()
    .then(() => handler(context))
    .then(
      (result): { result: unknown } | { timedOut: true } | { error: unknown } => {
        if (timedOut) return { timedOut: true };
        return { result };
      },
      (error): { result: unknown } | { timedOut: true } | { error: unknown } => {
        if (timedOut) return { timedOut: true };
        return { error };
      },
    );

  handlerPromise.catch(() => undefined);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    timer.unref();

    handlerPromise.then((result) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function blockingFailureDecision(message: string): PolicyDecisionMirror {
  return { decision: 'block', reason: message };
}

export async function executePolicyGate(
  options: ExecutePolicyGateOptions,
): Promise<PolicyGateExecutionResult> {
  if (options.context.gateKind !== options.gateKind) {
    throw new Error(
      `Policy gate context kind "${options.context.gateKind}" does not match requested gate "${options.gateKind}"`,
    );
  }

  const events: PolicyDiagnosticEvent[] = [];
  const registrations = (options.registry?.policyGates ?? [])
    .filter((registration) => registration.gateKind === options.gateKind);

  for (const registration of registrations) {
    const result = await executeHandlerWithTimeout(registration, options.context, options.timeoutMs);

    if ('timedOut' in result) {
      events.push(makeTimeoutEvent(registration, options.context, options.failurePolicy, options.timeoutMs));
      if (options.failurePolicy === 'fail-open') continue;
      const decision = blockingFailureDecision(`Policy gate ${registration.method} timed out after ${options.timeoutMs}ms`);
      events.push(makeDecisionEvent(registration, options.context, options.failurePolicy, decision));
      return { decision, blocked: true, events };
    }

    if ('error' in result) {
      events.push(makeFailedEvent(registration, options.context, options.failurePolicy, result.error));
      if (options.failurePolicy === 'fail-open') continue;
      const decision = blockingFailureDecision(`Policy gate ${registration.method} failed: ${errorMessage(result.error)}`);
      events.push(makeDecisionEvent(registration, options.context, options.failurePolicy, decision));
      return { decision, blocked: true, events };
    }

    let decision: PolicyDecisionMirror;
    try {
      decision = validatePolicyDecision(result.result);
    } catch (error) {
      events.push(makeFailedEvent(registration, options.context, options.failurePolicy, error));
      if (options.failurePolicy === 'fail-open') continue;
      decision = blockingFailureDecision(`Policy gate ${registration.method} returned an invalid decision: ${errorMessage(error)}`);
      events.push(makeDecisionEvent(registration, options.context, options.failurePolicy, decision));
      return { decision, blocked: true, events };
    }

    events.push(makeDecisionEvent(registration, options.context, options.failurePolicy, decision));
    if (decision.decision === 'block' || decision.decision === 'require-approval') {
      return { decision, blocked: true, events };
    }
  }

  return { decision: { decision: 'allow' }, blocked: false, events };
}
