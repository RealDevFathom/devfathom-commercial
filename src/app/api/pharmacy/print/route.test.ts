import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const printJob = vi.hoisted(() => vi.fn());

vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn(async () => ({ session: { user: { id: 'user-a' } } })),
}));
vi.mock('@/server/routers/_app', () => ({
  appRouter: { createCaller: () => ({ pharmacySales: { counterReceiptPrintJob: printJob } }) },
}));

import { GET } from './route';

const request = (suffix = '') =>
  new Request(
    `http://lan.local/api/pharmacy/print?branchId=branch-a&saleId=sale-a&locale=en${suffix}`
  );

beforeEach(() => printJob.mockReset());

describe('GET /api/pharmacy/print', () => {
  it('does not accept a caller-controlled reprint marker', async () => {
    printJob.mockResolvedValue({ status: 'READY', reprint: false, document: { kind: 'RECEIPT' } });
    expect((await GET(request('&reprint=0'))).status).toBe(400);
    expect((await GET(request('&reprint=1'))).status).toBe(400);
    expect(printJob).not.toHaveBeenCalled();
  });

  it('returns the server-assigned copy marker without passing one to the router', async () => {
    printJob.mockResolvedValue({ status: 'READY', reprint: true, document: { kind: 'RECEIPT' } });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(printJob).toHaveBeenCalledWith({ branchId: 'branch-a', saleId: 'sale-a', locale: 'en' });
    await expect(response.json()).resolves.toMatchObject({ mode: 'ESC_POS_JOB', reprint: true });
  });

  it('surfaces a forbidden receipt read as 403 and does not invent a payload', async () => {
    printJob.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' })
    );
    const response = await GET(request());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Branch is outside your scope.' });
  });
});
