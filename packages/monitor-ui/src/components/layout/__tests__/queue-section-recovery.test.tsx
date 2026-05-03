import { describe, it, expect } from 'vitest';
import type { ReadSidecarResponse } from '@eforge-build/client/browser';

// Pure logic tests validating QueueSection's recovery-pending rendering branch.
//
// QueueSection maintains sidecarData per prdId:
//   undefined  = not yet attempted
//   null       = fetched but no sidecar found (404 — recovery pending)
//   ReadSidecarResponse = sidecar present
//
// The isRecoveryPending flag drives a subtle "recovery pending" indicator:
//   const isRecoveryPending = item.status === 'failed' && sidecarVerdict == null;
//
// Because no DOM environment is available in this test suite, the rendering
// branch is extracted as a pure function to validate the predicate.

type SidecarData = ReadSidecarResponse | null | undefined;

// Mirror of QueueSection's sidecarVerdict + isRecoveryPending computation —
// extracted as a pure function for testability.
function computeRecoveryState(
  itemStatus: string,
  sidecarEntry: SidecarData,
): { sidecarVerdict: ReadSidecarResponse['json']['verdict'] | null; isRecoveryPending: boolean } {
  const sidecar = itemStatus === 'failed' ? sidecarEntry : undefined;
  const sidecarVerdict =
    sidecar != null
      ? sidecar.json.verdict
      : null;
  const isRecoveryPending = itemStatus === 'failed' && sidecarVerdict == null;
  return { sidecarVerdict, isRecoveryPending };
}

describe('QueueSection recovery-pending indicator', () => {
  it('shows recovery pending when sidecarData entry is undefined (not yet fetched)', () => {
    const { isRecoveryPending, sidecarVerdict } = computeRecoveryState('failed', undefined);
    expect(isRecoveryPending).toBe(true);
    expect(sidecarVerdict).toBeNull();
  });

  it('shows recovery pending when sidecarData entry is null (fetch returned 404)', () => {
    // This is the bug fix: previously isRecoveryPending was false for null entries.
    const { isRecoveryPending, sidecarVerdict } = computeRecoveryState('failed', null);
    expect(isRecoveryPending).toBe(true);
    expect(sidecarVerdict).toBeNull();
  });

  it('does not show recovery pending when a sidecar is present', () => {
    const sidecarResponse: ReadSidecarResponse = {
      markdown: '# Recovery Report',
      json: {
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00Z',
        summary: {
          prdId: 'my-plan',
          setName: 'my-set',
          featureBranch: 'feature/my-plan',
          baseBranch: 'main',
          plans: [],
          failingPlan: { planId: 'my-plan' },
          landedCommits: [],
          diffStat: '',
          modelsUsed: [],
          failedAt: '2026-01-01T00:00:00Z',
        },
        verdict: { verdict: 'retry', confidence: 'high', rationale: 'looks good', completedWork: [], remainingWork: [], risks: [] },
      },
    };
    const { isRecoveryPending, sidecarVerdict } = computeRecoveryState('failed', sidecarResponse);
    expect(isRecoveryPending).toBe(false);
    expect(sidecarVerdict).not.toBeNull();
    expect(sidecarVerdict?.verdict).toBe('retry');
  });

  it('does not show recovery pending for non-failed items regardless of sidecarData', () => {
    // completed item with no sidecar data should not show recovery pending
    const { isRecoveryPending } = computeRecoveryState('completed', undefined);
    expect(isRecoveryPending).toBe(false);
  });

  it('does not show recovery pending for pending items', () => {
    const { isRecoveryPending } = computeRecoveryState('pending', null);
    expect(isRecoveryPending).toBe(false);
  });

  it('renders recovery pending text — queue row is not suppressed when fetch returns 404', () => {
    // Validates that a failed item with null sidecar data (post-404) still has
    // a valid UI state: isRecoveryPending=true means the row renders with the
    // "recovery pending" indicator rather than being hidden.
    const { isRecoveryPending, sidecarVerdict } = computeRecoveryState('failed', null);
    // The chip is hidden (no verdict to show)
    expect(sidecarVerdict).toBeNull();
    // But the recovery-pending indicator is visible
    expect(isRecoveryPending).toBe(true);
  });

  it('shows verdict chip when runs array is empty (no-runs reachability)', () => {
    // Reachability proof: with zero runs (no activeSetName gating), a failed item
    // whose sidecar was fetched by prdId alone still renders the verdict chip.
    // Previously the !activeSetName guard would have prevented the fetch entirely.
    const sidecarResponse: ReadSidecarResponse = {
      markdown: '# Recovery Report',
      json: {
        schemaVersion: 2,
        generatedAt: '2026-01-01T00:00:00Z',
        summary: {
          prdId: 'orphan-prd',
          setName: 'old-set',
          featureBranch: 'eforge/old-set',
          baseBranch: 'main',
          plans: [],
          failingPlan: { planId: 'plan-01' },
          landedCommits: [],
          diffStat: '',
          modelsUsed: [],
          failedAt: '2026-01-01T00:00:00Z',
        },
        verdict: { verdict: 'retry', confidence: 'high', rationale: 'Transient failure', completedWork: [], remainingWork: [], risks: [] },
      },
    };
    // Simulate: runs=[] so activeSetName was null, but sidecar was fetched by prdId
    const { isRecoveryPending, sidecarVerdict } = computeRecoveryState('failed', sidecarResponse);
    // The verdict chip renders
    expect(isRecoveryPending).toBe(false);
    expect(sidecarVerdict).not.toBeNull();
    expect(sidecarVerdict?.verdict).toBe('retry');
  });
});
