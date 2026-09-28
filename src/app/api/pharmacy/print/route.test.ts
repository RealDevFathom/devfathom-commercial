import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTRPCContext: vi.fn(),
  counterReceiptPrintJob: vi.fn(),
}));

vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/_app', () => ({
  appRouter: {
    createCaller: () => ({
      pharmacySales: { counterReceiptPrintJob: mocks.counterReceiptPrintJob },
    }),
  },
}));

import { GET } from './route';

const url = (query: string) => new Request(`https://devfathom.test/api/pharmacy/print?${query}`);
const ready = {
  status: 'READY',
  document: { type: 'RECEIPT', reference: 'receipt:7' },
  escPos: { encoding: 'base64', data: 'G0A=', byteCount: 2 },
  paperWidth: 80,
  reprint: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createTRPCContext.mockResolvedValue({});
  mocks.counterReceiptPrintJob.mockResolvedValue(ready);
});

describe('GET /api/pharmacy/print', () => {
  it('returns the ESC/POS job through the app-router pharmacySales path, never cached', async () => {
    const response = await GET(url('branchId=b1&saleId=s1&locale=en&reprint=1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ mode: 'ESC_POS_JOB', ...ready });
    expect(mocks.counterReceiptPrintJob).toHaveBeenCalledWith({
      branchId: 'b1',
      saleId: 's1',
      locale: 'en',
      reprint: true,
    });
  });

  it('defaults to an English first print', async () => {
    await GET(url('branchId=b1&saleId=s1'));
    expect(mocks.counterReceiptPrintJob).toHaveBeenCalledWith({
      branchId: 'b1',
      saleId: 's1',
      locale: 'en',
      reprint: false,
    });
  });

  it('returns 422 with the browser/OS fallback, matching the Restaurant bridge contract', async () => {
    mocks.counterReceiptPrintJob.mockResolvedValue({
      status: 'FALLBACK',
      code: 'UNSUPPORTED_PRINT_TEXT',
      fallback: 'BROWSER_OS',
      message: 'Unsupported printer text. Use a browser/OS-rendered receipt.',
    });
    const response = await GET(url('branchId=b1&saleId=s1&locale=ur'));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: 'Unsupported printer text. Use a browser/OS-rendered receipt.',
      code: 'UNSUPPORTED_PRINT_TEXT',
      fallback: 'BROWSER_OS',
      retryable: false,
    });
  });

  it.each([
    'saleId=s1',
    'branchId=b1',
    'branchId=b1&saleId=s1&locale=fr',
    'branchId=b1&saleId=s1&reprint=yes',
    'branchId=b1&saleId=s1&extra=1',
  ])('rejects an invalid query before building context: %s', async (query) => {
    const response = await GET(url(query));
    expect(response.status).toBe(400);
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });

  it.each([
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['BAD_REQUEST', 400],
  ] as const)('maps %s to HTTP %i', async (code, status) => {
    mocks.counterReceiptPrintJob.mockRejectedValue(new TRPCError({ code, message: code }));
    const response = await GET(url('branchId=b1&saleId=s1'));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code });
  });

  it('does not swallow unexpected failures', async () => {
    mocks.counterReceiptPrintJob.mockRejectedValue(new Error('database down'));
    await expect(GET(url('branchId=b1&saleId=s1'))).rejects.toThrow('database down');
    mocks.counterReceiptPrintJob.mockRejectedValue(
      new TRPCError({ code: 'INTERNAL_SERVER_ERROR' })
    );
    await expect(GET(url('branchId=b1&saleId=s1'))).rejects.toBeInstanceOf(TRPCError);
  });
});
