import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchFbrInvoices, enqueueFbrInvoice } from './outbox';
import { MockFbrAdapter, type FiscalInvoice } from './adapter';

const invoice: FiscalInvoice = {
  usin: 'sale-key',
  issuedAt: '2026-10-21T10:00:00.000Z',
  totalMinor: 100,
  discountMinor: 0,
  lines: [
    { code: 'item', description: 'Item', quantity: 1, unitPriceMinor: 100, discountMinor: 0 },
  ],
};
const scope = { organizationId: 'org_session', branchId: 'branch_a' };
const now = new Date('2026-10-21T10:00:00.000Z');
function fixture() {
  return {
    $queryRaw: vi
      .fn()
      .mockResolvedValue([{ id: 'row', saleId: 'sale', payload: invoice, attempts: 0 }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    pharmacySale: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('tenant FBR outbox', () => {
  it('persists an idempotent tenant-specific snapshot and never resets submitted sales', async () => {
    vi.stubEnv('FBR_MODE', 'mock');
    const db = fixture();
    await enqueueFbrInvoice(db as never, scope, 'sale', invoice);
    const sql = db.$executeRaw.mock.calls[0]![0];
    expect(sql.values).toContain(scope.organizationId);
    expect(sql.values).toContain(scope.branchId);
    expect(sql.sql).toContain('ON CONFLICT ("organizationId", "saleId") DO NOTHING');
    expect(db.pharmacySale.updateMany).toHaveBeenCalledWith({
      where: { ...scope, id: 'sale', fbrStatus: null },
      data: { fbrStatus: 'PENDING' },
    });
  });
  it('limits claims to due rows in the authorized branch and records success', async () => {
    const db = fixture();
    expect(await dispatchFbrInvoices(db as never, scope, new MockFbrAdapter(), now)).toEqual({
      processed: 1,
      submitted: 1,
    });
    const claim = db.$queryRaw.mock.calls[0]![0];
    expect(claim.values).toEqual([scope.organizationId, scope.branchId, now]);
    expect(claim.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim.sql).toContain("status='PENDING'");
    expect(db.pharmacySale.update).toHaveBeenCalledWith({
      where: {
        organizationId_id: {
          organizationId: scope.organizationId,
          id: 'sale',
        },
      },
      data: {
        fbrStatus: 'SUBMITTED',
        fbrInvoiceNumber: (await new MockFbrAdapter().submit(invoice)).invoiceNumber,
      },
    });
  });
  it('retains failures for retry, redacts errors, and later submits the same snapshot', async () => {
    const db = fixture();
    const adapter = new MockFbrAdapter();
    vi.spyOn(adapter, 'submit').mockRejectedValueOnce(new Error('secret token and buyer'));
    expect(await dispatchFbrInvoices(db as never, scope, adapter, now)).toEqual({
      processed: 1,
      submitted: 0,
    });
    expect(db.pharmacySale.update).not.toHaveBeenCalled();
    const retry = db.$executeRaw.mock.calls[0]![0];
    expect(retry.values).toContainEqual(new Date('2026-10-21T10:00:05.000Z'));
    expect(retry.sql).toContain("'SUBMISSION_FAILED'");
    expect(JSON.stringify(retry)).not.toContain('secret');
    expect(
      await dispatchFbrInvoices(db as never, scope, adapter, new Date(now.getTime() + 5000))
    ).toEqual({ processed: 1, submitted: 1 });
  });
  it('does not submit any row when none are due', async () => {
    const db = fixture();
    db.$queryRaw.mockResolvedValue([]);
    const adapter = new MockFbrAdapter();
    const submit = vi.spyOn(adapter, 'submit');
    expect(await dispatchFbrInvoices(db as never, scope, adapter, now)).toEqual({
      processed: 0,
      submitted: 0,
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
