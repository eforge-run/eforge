import { describe, it, expect } from 'vitest';
import React from 'react';
import { SWRConfig } from 'swr';
import { SWRConfigProvider } from '../swr-config';

// Pure-logic smoke test for <SWRConfigProvider>.
//
// Because no DOM environment is available in this test suite, the component is
// invoked as a function (React components are just functions) and we inspect
// the returned React element directly — without rendering it to a DOM.
//
// This validates:
//   1. The component can be imported and called without throwing.
//   2. It returns a valid React element whose top-level component is SWRConfig.
//   3. The element's value prop carries the four required defaults.
//   4. The children prop is forwarded to the wrapper.

describe('SWRConfigProvider', () => {
  it('does not throw when called', () => {
    expect(() => SWRConfigProvider({ children: React.createElement('span') })).not.toThrow();
  });

  it('returns a valid React element', () => {
    const element = SWRConfigProvider({ children: React.createElement('span') });
    expect(React.isValidElement(element)).toBe(true);
  });

  it('top-level component is SWRConfig', () => {
    const element = SWRConfigProvider({ children: React.createElement('span') });
    expect(element.type).toBe(SWRConfig);
  });

  it('props.value contains revalidateOnFocus: true', () => {
    const element = SWRConfigProvider({ children: React.createElement('span') });
    const value = (element.props as { value: Record<string, unknown> }).value;
    expect(value.revalidateOnFocus).toBe(true);
  });

  it('props.value contains revalidateOnReconnect: true', () => {
    const element = SWRConfigProvider({ children: React.createElement('span') });
    const value = (element.props as { value: Record<string, unknown> }).value;
    expect(value.revalidateOnReconnect).toBe(true);
  });

  it('props.value contains dedupingInterval: 2000', () => {
    const element = SWRConfigProvider({ children: React.createElement('span') });
    const value = (element.props as { value: Record<string, unknown> }).value;
    expect(value.dedupingInterval).toBe(2000);
  });

  it('props.value contains errorRetryInterval: 5000', () => {
    const element = SWRConfigProvider({ children: React.createElement('span') });
    const value = (element.props as { value: Record<string, unknown> }).value;
    expect(value.errorRetryInterval).toBe(5000);
  });

  it('forwards children to the wrapper', () => {
    const child = React.createElement('span', { id: 'test-child' });
    const element = SWRConfigProvider({ children: child });
    expect((element.props as { children: unknown }).children).toBe(child);
  });
});
