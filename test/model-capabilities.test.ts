/**
 * Model capabilities — lookup and effort clamping.
 */

import { describe, it, expect } from 'vitest';
import { lookupCapabilities, clampEffort } from '@eforge-build/engine/model-capabilities';

// ---------------------------------------------------------------------------
// lookupCapabilities
// ---------------------------------------------------------------------------

describe('lookupCapabilities', () => {
  it('returns capabilities for Opus 4.6', () => {
    const caps = lookupCapabilities('claude-opus-4-6');
    expect(caps).toBeDefined();
    expect(caps!.supportedEffort).toContain('max');
  });

  it('returns capabilities for Opus 4.7', () => {
    const caps = lookupCapabilities('claude-opus-4-7');
    expect(caps).toBeDefined();
    expect(caps!.supportedEffort).toContain('max');
    expect(caps!.supportedEffort).toContain('xhigh');
  });

  it('returns capabilities for Sonnet 4', () => {
    const caps = lookupCapabilities('claude-sonnet-4-5');
    expect(caps).toBeDefined();
    expect(caps!.supportedEffort).toContain('xhigh');
    expect(caps!.supportedEffort).not.toContain('max');
  });

  it('returns capabilities for Haiku 4', () => {
    const caps = lookupCapabilities('claude-haiku-4');
    expect(caps).toBeDefined();
    expect(caps!.supportedEffort).toContain('high');
    expect(caps!.supportedEffort).not.toContain('xhigh');
    expect(caps!.supportedEffort).not.toContain('max');
  });

  it('returns undefined for unknown model', () => {
    expect(lookupCapabilities('unknown-model')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clampEffort
// ---------------------------------------------------------------------------

describe('clampEffort', () => {
  it('passes through supported values on Opus 4.7', () => {
    expect(clampEffort('claude-opus-4-7', 'max')).toEqual({ value: 'max', clamped: false });
    expect(clampEffort('claude-opus-4-7', 'xhigh')).toEqual({ value: 'xhigh', clamped: false });
    expect(clampEffort('claude-opus-4-7', 'high')).toEqual({ value: 'high', clamped: false });
  });

  it('clamps max to xhigh on Sonnet 4', () => {
    expect(clampEffort('claude-sonnet-4-5', 'max')).toEqual({ value: 'xhigh', clamped: true });
  });

  it('clamps max to high on Haiku 4', () => {
    expect(clampEffort('claude-haiku-4', 'max')).toEqual({ value: 'high', clamped: true });
  });

  it('clamps xhigh to high on Haiku 4', () => {
    expect(clampEffort('claude-haiku-4', 'xhigh')).toEqual({ value: 'high', clamped: true });
  });

  it('passes through without clamp for unknown model', () => {
    expect(clampEffort('unknown-model', 'max')).toEqual({ value: 'max', clamped: false });
  });

  it('returns undefined for undefined input', () => {
    expect(clampEffort('claude-opus-4-7', undefined)).toBeUndefined();
  });

  it('passes through low values on all models', () => {
    expect(clampEffort('claude-haiku-4', 'low')).toEqual({ value: 'low', clamped: false });
    expect(clampEffort('claude-sonnet-4-5', 'low')).toEqual({ value: 'low', clamped: false });
    expect(clampEffort('claude-opus-4-7', 'low')).toEqual({ value: 'low', clamped: false });
  });
});
