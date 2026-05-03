import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentProps } from 'react';
import { Sidebar } from '../sidebar';

// Pure-logic / static-analysis tests for <Sidebar>.
//
// Because no DOM environment is available in this test suite, we verify the
// contract through:
//   1. TypeScript type-level assertions (compiled away at runtime, but the
//      file refuses to compile if the assertion fails).
//   2. Source-file grep checks to confirm the implementation wiring.
//
// This mirrors the pattern used in queue-section-recovery.test.tsx and
// event-card.test.tsx.

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidebarSource = readFileSync(resolve(__dirname, '../sidebar.tsx'), 'utf-8');

// Strip comment-only lines before grepping — same pattern as api-routes-compliance.test.tsx.
const sidebarSourceLines = sidebarSource
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    return (
      !trimmed.startsWith('//') &&
      !trimmed.startsWith('*') &&
      !trimmed.startsWith('/*')
    );
  });
const sidebarSourceStripped = sidebarSourceLines.join('\n');

// ---------------------------------------------------------------------------
// Type-level: Sidebar does not accept a refreshTrigger prop
// ---------------------------------------------------------------------------

type SidebarProps = ComponentProps<typeof Sidebar>;

// This conditional type evaluates to `true` only if 'refreshTrigger' is NOT
// a key of SidebarProps. If refreshTrigger is reintroduced, the type
// evaluates to `never` and the assignment below fails to compile.
type NoRefreshTriggerProp = 'refreshTrigger' extends keyof SidebarProps ? never : true;

const _typeCheck: NoRefreshTriggerProp = true;

describe('Sidebar', () => {
  it('does not accept a refreshTrigger prop (type-level check)', () => {
    // Compiles only if NoRefreshTriggerProp === true
    expect(_typeCheck).toBe(true);
  });

  it('source does not reference refreshTrigger', () => {
    expect(sidebarSourceStripped).not.toContain('refreshTrigger');
  });

  it('source does not import useApi', () => {
    expect(sidebarSourceStripped).not.toContain('use-api');
    expect(sidebarSourceStripped).not.toMatch(/import\s*\{[^}]*useApi/);
  });

  it('source calls useSWR with API_ROUTES.runs', () => {
    expect(sidebarSourceStripped).toMatch(/useSWR[^(]*\(API_ROUTES\.runs/);
  });

  it('source calls useSWR with API_ROUTES.sessionMetadata', () => {
    expect(sidebarSourceStripped).toMatch(/useSWR[^(]*\(API_ROUTES\.sessionMetadata/);
  });
});
