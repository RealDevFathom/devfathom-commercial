import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configuredFiscalAdapter,
  fiscalRetryAt,
  MockFbrAdapter,
  type FiscalInvoice,
} from './adapter';

export const invoice: FiscalInvoice = {
  usin: 'tenant-branch-sale',
  issuedAt: '2026-10-21T10:00:00.000Z',
  totalMinor: 180,
  discountMinor: 20,
  lines: [
    { code: 'item', description: 'Item', quantity: 2, unitPriceMinor: 100, discountMinor: 20 },
  ],
};
afterEach(() => vi.unstubAllEnvs());
describe('mock FBR boundary', () => {
  it('is opt-in and never enables a live transport', () => {
    for (const mode of ['', 'live', 'sandbox']) {
      vi.stubEnv('FBR_MODE', mode);
      expect(configuredFiscalAdapter()).toBeNull();
    }
    vi.stubEnv('FBR_MODE', 'mock');
    expect(configuredFiscalAdapter()).toBeInstanceOf(MockFbrAdapter);
  });
  it('is deterministic across instances and distinguishes USINs without network', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    try {
      const first = await new MockFbrAdapter().submit(invoice);
      expect(await new MockFbrAdapter().submit(invoice)).toEqual(first);
      expect(
        await new MockFbrAdapter().submit({ ...invoice, usin: 'other-tenant-sale' })
      ).not.toEqual(first);
      expect(new MockFbrAdapter().qrPayload(first.invoiceNumber)).toBe(first.invoiceNumber);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it('rejects malformed snapshots and unsupported credit notes', async () => {
    await expect(new MockFbrAdapter().submit({ ...invoice, totalMinor: -1 })).rejects.toThrow();
    await expect(new MockFbrAdapter().creditNote()).rejects.toThrow('not implemented');
  });
  it('backs off from five seconds with an hour cap', () => {
    const now = new Date('2026-10-21T10:00:00.000Z');
    expect(fiscalRetryAt(1, now).toISOString()).toBe('2026-10-21T10:00:05.000Z');
    expect(fiscalRetryAt(2, now).toISOString()).toBe('2026-10-21T10:00:10.000Z');
    expect(fiscalRetryAt(100, now).toISOString()).toBe('2026-10-21T11:00:00.000Z');
  });
});
