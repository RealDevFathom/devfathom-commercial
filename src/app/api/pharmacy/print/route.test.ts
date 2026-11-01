import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

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

import { GET } from './route';

function request(reprint: string) {
  return new Request(
    `http://lan.local/api/pharmacy/print?branchId=branch-a&saleId=sale-a&locale=en&reprint=${reprint}`
  );
}

beforeEach(() => {
  printJob.mockReset();
});

describe('GET /api/pharmacy/print', () => {
  it('returns the guarded print job for a first print and a reprint', async () => {
    printJob.mockImplementation(async (input: { reprint: boolean }) => ({
      status: 'READY',
      reprint: input.reprint,
      document: { kind: 'RECEIPT' },
    }));
    const first = await GET(request('0'));
    const again = await GET(request('1'));
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(printJob).toHaveBeenNthCalledWith(1, {
      branchId: 'branch-a',
      saleId: 'sale-a',
      locale: 'en',
      reprint: false,
    });
    expect(printJob).toHaveBeenNthCalledWith(2, {
      branchId: 'branch-a',
      saleId: 'sale-a',
      locale: 'en',
      reprint: true,
    });
    await expect(again.json()).resolves.toMatchObject({ mode: 'ESC_POS_JOB', reprint: true });
  });

  it('surfaces a forbidden receipt read as 403 and does not invent a payload', async () => {
    printJob.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' })
    );
    const response = await GET(request('1'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Branch is outside your scope.' });
  });
});
