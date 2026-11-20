import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ context: vi.fn(), read: vi.fn(), audit: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/audit', () => ({ recordTrpcAudit: mocks.audit }));
vi.mock('@/lib/pharmacy/accounts/fiscal-exceptions.reader', () => ({ readFiscalExceptions: mocks.read }));
import { loadFiscalExceptionRegister } from './access';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({ session: { user: { id: 'owner' } }, audit: { detail: {} } });
  mocks.audit.mockResolvedValue(undefined);
});

describe('isolated fiscal evidence sensitive-read audit', () => {
  it('audits successful page and CSV reads without capturing evidence or input', async () => {
    mocks.read.mockResolvedValue({ rows: [] });
    await loadFiscalExceptionRegister({ private: 'not logged' });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({
      path: 'pharmacyAccounts.fiscalExceptions', type: 'query', input: undefined, outcome: 'SUCCESS',
      ctx: expect.objectContaining({ audit: { detail: {
        category: 'PHARMACY_ACCOUNTS', operation: 'READ', skipInput: true,
      } } }),
    }));
    const request = new Request('https://workspace.example/pharmacy/accounts/fiscal-exceptions/csv');
    await loadFiscalExceptionRegister({}, request);
    expect(mocks.context).toHaveBeenLastCalledWith({ req: request });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({
      path: 'pharmacyAccounts.fiscalExceptionsCsv', outcome: 'SUCCESS',
    }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('not logged');
  });

  it('audits permission denial and normalizes unexpected errors', async () => {
    mocks.read.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(loadFiscalExceptionRegister({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
    mocks.read.mockRejectedValue(new Error('sensitive raw SQL'));
    await expect(loadFiscalExceptionRegister({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR', message: 'Fiscal evidence is unavailable.',
    });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('sensitive raw SQL');
  });

  it('fills a missing window from the organisation\'s today, keeping typed dates (DEV-722)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-31T19:30:00Z')); // 00:30 on 1 Aug in Karachi
      mocks.context.mockResolvedValue({ session: { user: { id: 'owner' } }, audit: { detail: {} },
        organization: { timezone: 'Asia/Karachi' } });
      mocks.read.mockResolvedValue({ rows: [] });
      await loadFiscalExceptionRegister({ branchId: 'b', from: undefined, to: undefined });
      expect(mocks.read).toHaveBeenLastCalledWith(expect.anything(),
        { branchId: 'b', from: '2026-07-26', to: '2026-08-02' });
      await loadFiscalExceptionRegister({ branchId: 'b', from: '2026-01-01', to: '2026-01-02' });
      expect(mocks.read).toHaveBeenLastCalledWith(expect.anything(),
        { branchId: 'b', from: '2026-01-01', to: '2026-01-02' });
    } finally {
      vi.useRealTimers();
    }
  });
});
