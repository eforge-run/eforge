import { describe, it, expect } from 'vitest';
import {
  handleExpeditionArchitectureComplete,
  handleExpeditionModuleStart,
  handleExpeditionModuleComplete,
} from '../handle-expedition';
import { initialRunState } from '../../reducer';
import type { EforgeEvent } from '../../types';

function makeEvent<T extends EforgeEvent['type']>(
  type: T,
  extra: object,
): Extract<EforgeEvent, { type: T }> {
  return { type, timestamp: '2024-01-15T10:00:00.000Z', sessionId: 's1', ...extra } as unknown as Extract<EforgeEvent, { type: T }>;
}

const MODULES = [
  { id: 'mod-01', description: 'Module One', dependsOn: [] },
  { id: 'mod-02', description: 'Module Two', dependsOn: ['mod-01'] },
];

describe('handle-expedition', () => {
  // ---------------------------------------------------------------------------
  // expedition:architecture:complete
  // ---------------------------------------------------------------------------
  describe('handleExpeditionArchitectureComplete', () => {
    it('seeds moduleStatuses to pending for each module', () => {
      const event = makeEvent('expedition:architecture:complete', { modules: MODULES });
      const delta = handleExpeditionArchitectureComplete(event, initialRunState);
      expect(delta?.moduleStatuses).toEqual({ 'mod-01': 'pending', 'mod-02': 'pending' });
    });

    it('sets expeditionModules from the event', () => {
      const event = makeEvent('expedition:architecture:complete', { modules: MODULES });
      const delta = handleExpeditionArchitectureComplete(event, initialRunState);
      expect(delta?.expeditionModules).toEqual(MODULES);
    });

    it('synthesizes earlyOrchestration with mode=expedition and one plan per module', () => {
      const event = makeEvent('expedition:architecture:complete', { modules: MODULES });
      const delta = handleExpeditionArchitectureComplete(event, initialRunState);
      const orch = delta?.earlyOrchestration;
      expect(orch?.mode).toBe('expedition');
      expect(orch?.plans).toHaveLength(2);
      expect(orch?.plans?.[0]?.id).toBe('mod-01');
      expect(orch?.plans?.[1]?.dependsOn).toEqual(['mod-01']);
    });

    it('earlyOrchestration plan names come from module descriptions', () => {
      const event = makeEvent('expedition:architecture:complete', { modules: MODULES });
      const delta = handleExpeditionArchitectureComplete(event, initialRunState);
      expect(delta?.earlyOrchestration?.plans?.[0]?.name).toBe('Module One');
      expect(delta?.earlyOrchestration?.plans?.[1]?.name).toBe('Module Two');
    });

    it('resets moduleStatuses (no carryover from prior state)', () => {
      const state = { ...initialRunState, moduleStatuses: { 'old-mod': 'complete' as const } };
      const event = makeEvent('expedition:architecture:complete', { modules: MODULES });
      const delta = handleExpeditionArchitectureComplete(event, state);
      expect(delta?.moduleStatuses?.['old-mod']).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // expedition:module:start / :complete
  // ---------------------------------------------------------------------------
  describe('handleExpeditionModuleStart', () => {
    it('sets moduleStatus to planning for the given moduleId', () => {
      const state = { ...initialRunState, moduleStatuses: { 'mod-01': 'pending' as const } };
      const event = makeEvent('expedition:module:start', { moduleId: 'mod-01' });
      const delta = handleExpeditionModuleStart(event, state);
      expect(delta?.moduleStatuses?.['mod-01']).toBe('planning');
    });

    it('preserves other module statuses', () => {
      const state = { ...initialRunState, moduleStatuses: { 'mod-01': 'pending' as const, 'mod-02': 'pending' as const } };
      const event = makeEvent('expedition:module:start', { moduleId: 'mod-01' });
      const delta = handleExpeditionModuleStart(event, state);
      expect(delta?.moduleStatuses?.['mod-02']).toBe('pending');
    });
  });

  describe('handleExpeditionModuleComplete', () => {
    it('sets moduleStatus to complete for the given moduleId', () => {
      const state = { ...initialRunState, moduleStatuses: { 'mod-01': 'planning' as const } };
      const event = makeEvent('expedition:module:complete', { moduleId: 'mod-01' });
      const delta = handleExpeditionModuleComplete(event, state);
      expect(delta?.moduleStatuses?.['mod-01']).toBe('complete');
    });
  });
});
