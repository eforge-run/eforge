import { describe, it, expect, vi, afterEach } from 'vitest';
import { API_ROUTES } from '@eforge-build/client/browser';
import { fetcher } from '../swr-fetcher';

function makeFetchResponse(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetcher', () => {
  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(404)));
    const result = await fetcher('/api/some-route');
    expect(result).toBeNull();
  });

  it('throws Error containing status code on 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(500)));
    await expect(fetcher('/api/some-route')).rejects.toThrow('HTTP 500');
  });

  it('throws Error containing status code on 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(403)));
    await expect(fetcher('/api/some-route')).rejects.toThrow('HTTP 403');
  });

  it('returns parsed JSON on 200', async () => {
    const payload = { sessionId: 'abc-123', status: 'running' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(200, payload)));
    const result = await fetcher(API_ROUTES.latestRun);
    expect(result).toEqual(payload);
  });

  it('tuple key [sidecar, prdId] fetches the correct URL with prdId in query params', async () => {
    const prdId = 'my-plan-01';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(200, { markdown: '', json: {} })));

    await fetcher(['sidecar', prdId]);

    const stub = vi.mocked(fetch as ReturnType<typeof vi.fn>);
    expect(stub).toHaveBeenCalledOnce();
    const calledUrl = stub.mock.calls[0][0] as string;
    expect(calledUrl).toContain(API_ROUTES.readRecoverySidecar);
    expect(calledUrl).toContain(`prdId=${encodeURIComponent(prdId)}`);
  });

  it('tuple key [sidecar, prdId] returns null on 404 (no sidecar present)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeFetchResponse(404)));
    const result = await fetcher(['sidecar', 'plan-not-found']);
    expect(result).toBeNull();
  });
});
