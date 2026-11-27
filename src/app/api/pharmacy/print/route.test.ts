import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { createTRPCContext } from '@/server/trpc';
import { oversizedRequest } from '../../../../../tests/fixtures/bounded-request';

const printJob = vi.hoisted(() => vi.fn());

vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn(async () => ({ session: { user: { id: 'user-a' } } })),
}));
vi.mock('@/server/routers/_app', () => ({
  appRouter: {
    createCaller: () => ({
      pharmacySales: { counterReceiptPrintJob: printJob },
    }),
  },
}));

import { GET, POST } from './route';

function request(body: object = { branchId: 'branch-a', saleId: 'sale-a', locale: 'en' }) {
  return new Request('http://lan.local/api/pharmacy/print', {
    method: 'POST',
    headers: { origin: 'http://lan.local', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  printJob.mockReset();
});

describe('/api/pharmacy/print', () => {
  it('stops reading at the print body cap before resolving a session', async () => {
    const limit = 4 * 1024;
    const input = oversizedRequest(limit, {
      url: 'http://lan.local/api/pharmacy/print',
      headers: { origin: 'http://lan.local', 'content-type': 'application/json' },
      chunkSize: 1024,
    });
    vi.mocked(createTRPCContext).mockClear();

    const response = await POST(input.request);
    expect(response.status).toBe(413);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(input.cancelled()).toBe(true);
    expect(input.bytesRead()).toBe(limit + 1024);
    expect(createTRPCContext).not.toHaveBeenCalled();
    expect(printJob).not.toHaveBeenCalled();
  });

  it('rejects GET without allocating a copy', async () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(printJob).not.toHaveBeenCalled();
  });

  it('returns the guarded print job from an authenticated same-origin POST', async () => {
    printJob
      .mockResolvedValueOnce({
        status: 'READY',
        copyNumber: 1,
        reprint: false,
        document: { kind: 'RECEIPT' },
      })
      .mockResolvedValueOnce({
        status: 'READY',
        copyNumber: 2,
        reprint: true,
        document: { kind: 'RECEIPT' },
      });
    const first = await POST(request());
    const again = await POST(request());
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(printJob).toHaveBeenNthCalledWith(1, {
      branchId: 'branch-a',
      saleId: 'sale-a',
      locale: 'en',
    });
    expect(printJob).toHaveBeenNthCalledWith(2, {
      branchId: 'branch-a',
      saleId: 'sale-a',
      locale: 'en',
    });
    await expect(first.json()).resolves.toMatchObject({
      mode: 'ESC_POS_JOB',
      copyNumber: 1,
      reprint: false,
    });
    await expect(again.json()).resolves.toMatchObject({
      mode: 'ESC_POS_JOB',
      copyNumber: 2,
      reprint: true,
    });
  });

  it('surfaces a forbidden receipt read as 403 and does not invent a payload', async () => {
    printJob.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' })
    );
    const response = await POST(request());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Branch is outside your scope.' });
  });

  it('rejects cross-site, non-JSON, and caller-controlled copy-status POSTs', async () => {
    const missingOrigin = request();
    missingOrigin.headers.delete('origin');
    expect((await POST(missingOrigin)).status).toBe(403);
    const crossSite = request();
    crossSite.headers.set('origin', 'https://attacker.example');
    expect((await POST(crossSite)).status).toBe(403);
    const crossSiteFetchMetadata = request();
    crossSiteFetchMetadata.headers.set('sec-fetch-site', 'cross-site');
    expect((await POST(crossSiteFetchMetadata)).status).toBe(403);
    const nonJson = request();
    nonJson.headers.set('content-type', 'text/plain');
    expect((await POST(nonJson)).status).toBe(403);
    const jsonPrefix = request();
    jsonPrefix.headers.set('content-type', 'application/json-patch+json');
    expect((await POST(jsonPrefix)).status).toBe(403);
    expect(
      (await POST(request({ branchId: 'branch-a', saleId: 'sale-a', reprint: false }))).status
    ).toBe(400);
    expect(
      (
        await POST(
          new Request('http://lan.local/api/pharmacy/print', {
            method: 'POST',
            headers: { origin: 'http://lan.local', 'content-type': 'application/json' },
            body: '{',
          })
        )
      ).status
    ).toBe(400);
    expect(printJob).not.toHaveBeenCalled();
  });
});
