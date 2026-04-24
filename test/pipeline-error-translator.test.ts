/**
 * pipeline-error-translator — focused tests for toBuildFailedEvent.
 *
 * Covers:
 *   1. AgentTerminalError input produces a build:failed event with the matching terminalSubtype.
 *   2. Plain Error input produces a build:failed event without terminalSubtype.
 *   3. Non-Error throw value produces a build:failed event with a stringified message.
 */

import { describe, it, expect } from 'vitest';
import { AgentTerminalError } from '@eforge-build/engine/backend';
import { toBuildFailedEvent } from '@eforge-build/engine/pipeline';

describe('toBuildFailedEvent', () => {
  it('maps AgentTerminalError to a build:failed event with terminalSubtype', () => {
    const planId = 'plan-01';
    const err = new AgentTerminalError('error_max_turns', 'Reached maximum number of turns (80).');

    const event = toBuildFailedEvent(planId, err);

    expect(event.type).toBe('plan:build:failed');
    expect(event.planId).toBe(planId);
    expect(event.error).toBe(err.message);
    expect(event.terminalSubtype).toBe('error_max_turns');
  });

  it('maps AgentTerminalError with error_max_budget_usd subtype correctly', () => {
    const planId = 'plan-02';
    const err = new AgentTerminalError('error_max_budget_usd', 'Budget exceeded.');

    const event = toBuildFailedEvent(planId, err);

    expect(event.type).toBe('plan:build:failed');
    expect(event.planId).toBe(planId);
    expect(event.terminalSubtype).toBe('error_max_budget_usd');
  });

  it('maps a plain Error to a build:failed event without terminalSubtype', () => {
    const planId = 'plan-03';
    const err = new Error('Something went wrong');

    const event = toBuildFailedEvent(planId, err);

    expect(event.type).toBe('plan:build:failed');
    expect(event.planId).toBe(planId);
    expect(event.error).toBe('Something went wrong');
    expect(event.terminalSubtype).toBeUndefined();
  });

  it('maps a non-Error throw value to a build:failed event with stringified message', () => {
    const planId = 'plan-04';
    const thrown = 'string error value';

    const event = toBuildFailedEvent(planId, thrown);

    expect(event.type).toBe('plan:build:failed');
    expect(event.planId).toBe(planId);
    expect(event.error).toBe('string error value');
    expect(event.terminalSubtype).toBeUndefined();
  });

  it('maps a thrown object to a build:failed event with String() representation', () => {
    const planId = 'plan-05';
    const thrown = { code: 'ENOENT', message: 'file not found' };

    const event = toBuildFailedEvent(planId, thrown);

    expect(event.type).toBe('plan:build:failed');
    expect(event.planId).toBe(planId);
    expect(event.error).toBe(String(thrown));
    expect(event.terminalSubtype).toBeUndefined();
  });

  it('includes a timestamp in the ISO format', () => {
    const event = toBuildFailedEvent('plan-06', new Error('test'));

    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
