import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFinalMergePolicyGateContext,
  buildPlanMergePolicyGateContext,
  buildPolicyGateContext,
  buildQueueDispatchPolicyGateContext,
  executePolicyGate,
  validatePolicyDecision,
  type PolicyGateFailurePolicy,
} from '@eforge-build/engine/extensions';
import type { PolicyGateRegistration } from '@eforge-build/engine/extensions';

function registration(
  name: string,
  handler: (ctx: unknown) => unknown,
  index: number,
  gateKind: PolicyGateRegistration['gateKind'] = 'plan-merge',
): PolicyGateRegistration {
  const methodByKind = {
    'queue-dispatch': 'beforeQueueDispatch',
    'plan-merge': 'beforePlanMerge',
    'final-merge': 'beforeFinalMerge',
  } as const;
  return {
    kind: 'policyGate',
    extensionName: name,
    extensionPath: `/extensions/${name}.js`,
    gateKind,
    method: methodByKind[gateKind],
    registrationIndex: index,
    value: handler as never,
  };
}

function context() {
  return buildPlanMergePolicyGateContext({
    planId: 'plan-01',
    diff: { files: [{ path: 'src/index.ts', status: 'modified' }] },
  });
}

async function runPolicy(
  handlers: Array<(ctx: unknown) => unknown>,
  failurePolicy: PolicyGateFailurePolicy = 'fail-closed',
  timeoutMs = 25,
) {
  return executePolicyGate({
    registry: { policyGates: handlers.map((handler, index) => registration(`ext-${index}`, handler, index)) },
    gateKind: 'plan-merge',
    context: context(),
    failurePolicy,
    timeoutMs,
  });
}

describe('policy gate runtime', () => {
  it('builds read-only cloned gate-specific contexts', () => {
    const queueDependsOn = ['prd-a'];
    const queueContext = buildQueueDispatchPolicyGateContext({
      prdId: 'prd-b',
      prdTitle: 'Build B',
      priority: 3,
      dependsOn: queueDependsOn,
    });
    queueDependsOn.push('prd-c');

    expect(queueContext).toMatchObject({
      gateKind: 'queue-dispatch',
      prdId: 'prd-b',
      prdTitle: 'Build B',
      priority: 3,
      dependsOn: ['prd-a'],
    });
    expect(Object.isFrozen(queueContext)).toBe(true);
    expect(Object.isFrozen(queueContext.dependsOn)).toBe(true);

    const diff = { files: [{ path: 'src/index.ts', status: 'modified' as const }] };
    const finalPlanIds = ['plan-a'];
    const finalContext = buildFinalMergePolicyGateContext({
      featureBranch: 'feature',
      baseBranch: 'main',
      planIds: finalPlanIds,
      diff,
    });
    diff.files[0].path = 'src/changed.ts';
    finalPlanIds.push('plan-b');

    expect(finalContext).toMatchObject({
      gateKind: 'final-merge',
      featureBranch: 'feature',
      baseBranch: 'main',
      planIds: ['plan-a'],
      diff: { files: [{ path: 'src/index.ts', status: 'modified' }] },
    });
    expect(Object.isFrozen(finalContext.diff.files[0])).toBe(true);

    expect(buildPolicyGateContext({ gateKind: 'queue-dispatch', prdId: 'prd-c' })).toMatchObject({
      gateKind: 'queue-dispatch',
      prdId: 'prd-c',
      dependsOn: [],
    });
  });

  it('provides exec helper with cwd/env and subprocess exit codes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'eforge-policy-gate-exec-'));
    try {
      await writeFile(
        join(cwd, 'helper.mjs'),
        "console.log(process.cwd()); console.error(process.env.POLICY_GATE_TEST_ENV); process.exit(7);\n",
      );
      const gateContext = buildQueueDispatchPolicyGateContext(
        { prdId: 'prd-exec' },
        { cwd, env: { ...process.env, POLICY_GATE_TEST_ENV: 'from-helper' } },
      );

      const result = await gateContext.exec.run(process.execPath, ['helper.mjs']);

      expect(result.stdout.trim()).toBe(await realpath(cwd));
      expect(result.stderr.trim()).toBe('from-helper');
      expect(result.exitCode).toBe(7);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('allows when all handlers allow', async () => {
    const result = await runPolicy([
      () => ({ decision: 'allow' }),
      () => ({ decision: 'allow' }),
    ]);

    expect(result.blocked).toBe(false);
    expect(result.decision).toEqual({ decision: 'allow' });
    expect(result.events.map((event) => event.type)).toEqual([
      'extension:policy:decision',
      'extension:policy:decision',
    ]);
  });

  it('includes extension provenance and target identifiers in decision events', async () => {
    const result = await executePolicyGate({
      registry: { policyGates: [registration('queue-ext', () => ({ decision: 'allow' }), 7, 'queue-dispatch')] },
      gateKind: 'queue-dispatch',
      context: buildQueueDispatchPolicyGateContext({ prdId: 'prd-1', prdTitle: 'Ship it' }),
      failurePolicy: 'fail-closed',
      timeoutMs: 25,
    });

    expect(result.events[0]).toMatchObject({
      type: 'extension:policy:decision',
      extensionName: 'queue-ext',
      extensionPath: '/extensions/queue-ext.js',
      gateKind: 'queue-dispatch',
      method: 'beforeQueueDispatch',
      registrationIndex: 7,
      failurePolicy: 'fail-closed',
      prdId: 'prd-1',
      prdTitle: 'Ship it',
      decision: 'allow',
    });
  });

  it('rejects mismatched gate kind and context before producing invalid policy events', async () => {
    await expect(executePolicyGate({
      registry: { policyGates: [registration('queue-ext', () => ({ decision: 'allow' }), 0, 'queue-dispatch')] },
      gateKind: 'queue-dispatch',
      context: context(),
      failurePolicy: 'fail-closed',
      timeoutMs: 25,
    })).rejects.toThrow(/does not match requested gate/);
  });

  it('only runs registrations for the requested gate kind', async () => {
    const calls: string[] = [];
    const result = await executePolicyGate({
      registry: {
        policyGates: [
          registration('queue-ext', () => {
            calls.push('queue');
            return { decision: 'block', reason: 'not this gate' };
          }, 0, 'queue-dispatch'),
          registration('final-ext', () => {
            calls.push('final');
            return { decision: 'allow' };
          }, 1, 'final-merge'),
        ],
      },
      gateKind: 'final-merge',
      context: buildFinalMergePolicyGateContext({
        featureBranch: 'feature',
        baseBranch: 'main',
        planIds: ['plan-1'],
        diff: { files: [] },
      }),
      failurePolicy: 'fail-closed',
      timeoutMs: 25,
    });

    expect(calls).toEqual(['final']);
    expect(result.events[0]).toMatchObject({
      gateKind: 'final-merge',
      method: 'beforeFinalMerge',
      featureBranch: 'feature',
      baseBranch: 'main',
      planIds: ['plan-1'],
    });
  });

  it('stops at first block decision', async () => {
    const calls: string[] = [];
    const result = await runPolicy([
      () => {
        calls.push('first');
        return { decision: 'block', reason: 'blocked' };
      },
      () => {
        calls.push('second');
        return { decision: 'allow' };
      },
    ]);

    expect(calls).toEqual(['first']);
    expect(result.blocked).toBe(true);
    expect(result.decision).toEqual({ decision: 'block', reason: 'blocked' });
    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'extension:policy:decision',
        decision: 'block',
        reason: 'blocked',
        planId: 'plan-01',
      }),
    ]);
  });

  it('treats require-approval as blocking and stops later handlers', async () => {
    const calls: string[] = [];
    const result = await runPolicy([
      () => {
        calls.push('first');
        return { decision: 'require-approval', reason: 'manual approval required' };
      },
      () => {
        calls.push('second');
        return { decision: 'allow' };
      },
    ]);

    expect(calls).toEqual(['first']);
    expect(result.blocked).toBe(true);
    expect(result.decision).toEqual({ decision: 'require-approval', reason: 'manual approval required' });
    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'extension:policy:decision',
        decision: 'require-approval',
        reason: 'manual approval required',
        planId: 'plan-01',
      }),
    ]);
  });

  it('rejects invalid return values and mutation-shaped objects', () => {
    expect(() => validatePolicyDecision(undefined)).toThrow(/object policy decision/);
    expect(() => validatePolicyDecision({ decision: 'modify', patch: [] })).toThrow(/mutation-shaped/);
    expect(() => validatePolicyDecision({ decision: 'allow', patch: [] })).toThrow(/mutation-shaped/);
    expect(() => validatePolicyDecision({ decision: 'block' })).toThrow(/requires a non-empty reason/);
  });

  it('fail-closed emits a failure diagnostic plus blocking decision for invalid returns', async () => {
    const result = await runPolicy([() => ({ decision: 'wat' })], 'fail-closed');

    expect(result.blocked).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      'extension:policy:failed',
      'extension:policy:decision',
    ]);
    expect(result.events[0]).toMatchObject({
      message: 'Policy gate returned an invalid decision',
      failurePolicy: 'fail-closed',
    });
    expect(result.events[1]).toMatchObject({
      decision: 'block',
      reason: 'Policy gate beforePlanMerge returned an invalid decision: Policy gate returned an invalid decision',
      failurePolicy: 'fail-closed',
    });
  });

  it('fail-closed emits a failure diagnostic plus blocking decision for thrown errors', async () => {
    const result = await runPolicy([() => { throw new Error('boom'); }], 'fail-closed');

    expect(result.blocked).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      'extension:policy:failed',
      'extension:policy:decision',
    ]);
    expect(result.events[0]).toMatchObject({ message: 'boom', failurePolicy: 'fail-closed' });
    expect(result.events[1]).toMatchObject({
      decision: 'block',
      reason: 'Policy gate beforePlanMerge failed: boom',
      failurePolicy: 'fail-closed',
    });
  });

  it('fail-closed emits a timeout diagnostic plus blocking decision for timeouts', async () => {
    const result = await runPolicy([
      () => new Promise((resolve) => setTimeout(() => resolve({ decision: 'allow' }), 100)),
    ], 'fail-closed', 5);

    expect(result.blocked).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      'extension:policy:timeout',
      'extension:policy:decision',
    ]);
    expect(result.events[0]).toMatchObject({ timeoutMs: 5, failurePolicy: 'fail-closed' });
    expect(result.events[1]).toMatchObject({
      decision: 'block',
      reason: 'Policy gate beforePlanMerge timed out after 5ms',
      failurePolicy: 'fail-closed',
    });
  });

  it('fail-open emits diagnostics and continues after thrown errors, invalid returns, and timeouts', async () => {
    const calls: string[] = [];
    const result = await runPolicy([
      () => {
        calls.push('throw');
        throw new Error('boom');
      },
      () => {
        calls.push('invalid');
        return { decision: 'modify', changes: [] };
      },
      () => {
        calls.push('timeout');
        return new Promise((resolve) => setTimeout(() => resolve({ decision: 'allow' }), 100));
      },
      () => {
        calls.push('allow');
        return { decision: 'allow' };
      },
    ], 'fail-open', 5);

    expect(calls).toEqual(['throw', 'invalid', 'timeout', 'allow']);
    expect(result.blocked).toBe(false);
    expect(result.events.map((event) => event.type)).toEqual([
      'extension:policy:failed',
      'extension:policy:failed',
      'extension:policy:timeout',
      'extension:policy:decision',
    ]);
  });

  it('preserves sequential execution order', async () => {
    const calls: string[] = [];
    await runPolicy([
      async () => {
        calls.push('first:start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push('first:end');
        return { decision: 'allow' };
      },
      () => {
        calls.push('second');
        return { decision: 'allow' };
      },
    ]);

    expect(calls).toEqual(['first:start', 'first:end', 'second']);
  });
});
