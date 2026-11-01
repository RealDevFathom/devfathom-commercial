import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
vi.mock('server-only', () => ({}));
vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  postTenderEntry: vi.fn(), postTenderRefundEntry: vi.fn(),
}));
vi.mock('./sale-batch-safety', async () => ({
  ...(await vi.importActual<typeof import('./sale-batch-safety')>('./sale-batch-safety')),
  assertSaleBatchesSellable: vi.fn(),
}));
vi.mock('./rx-sale-gate', async () => ({
  ...(await vi.importActual<typeof import('./rx-sale-gate')>('./rx-sale-gate')),
  assertRxSaleAllowed: vi.fn(),
}));
vi.mock('./counter-evidence', () => ({ requestCounterEvidence: vi.fn() }));
vi.mock('./sale-completion', () => ({ completionSaleInclude: {}, completePaidPharmacySale: vi.fn(async () => 41) }));
import { applyPharmacyTender } from './settlement';
import { completePaidPharmacySale } from './sale-completion';
import { MANUAL_TENDER_TYPES } from './manual-payments';

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'cashier' };
beforeEach(() => vi.clearAllMocks());
function fixture(input: Parameters<typeof applyPharmacyTender>[2], allowReferenceSkip = false) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]), $executeRaw: vi.fn().mockResolvedValue(1),
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn().mockResolvedValue({ id: 'key', commandType: 'tender', payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), resultPayload: null }),
      update: vi.fn(),
    },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacySale: { findFirst: vi.fn().mockResolvedValue({ id: 'sale', status: 'OPEN', tenders: [], lines: [{ quantity: 1, unitPriceMinor: 1000, discountMinor: 0, medicine: {} }] }) },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ manualPaymentSettings: { [input.type]: { destination: 'Shop till', allowReferenceSkip } }, manualPaymentRevision: 1 }) },
    pharmacyTender: { create: vi.fn().mockResolvedValue({ id: 'tender', createdAt: new Date() }) },
    pharmacyDrawerMovement: { create: vi.fn() },
  };
  return { db, scoped: db as unknown as ScopedDb };
}
const base = { saleId: 'sale', deviceId: 'counter', businessDate: new Date('2026-10-31'), amountMinor: 1000, idempotencyKey: 'attempt', payerName: 'Ayesha' };
describe('#710 manual tender settlement', () => {
  it.each(MANUAL_TENDER_TYPES)('settles %s without a provider API or cash drawer', async (type) => {
    const input = { ...base, type, providerRef: '001234' };
    const { db, scoped } = fixture(input);
    expect(await applyPharmacyTender(scoped, scope, input)).toMatchObject({ settled: true, receiptNumber: 41, remainingMinor: 0 });
    expect(db.pharmacyTender.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type, provider: 'MANUAL_MERCHANT', providerRef: '001234', payerName: 'Ayesha', amountMinor: 1000 }) });
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
    expect(completePaidPharmacySale).toHaveBeenCalledOnce();
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org', id: 'branch', active: true } }));
  });
  it('refuses absent reference before tender creation or completion', async () => {
    const input = { ...base, type: 'RAAST' as const };
    const { db, scoped } = fixture(input);
    await expect(applyPharmacyTender(scoped, scope, input)).rejects.toMatchObject({ reason: 'INVALID_MANUAL_CAPTURE' });
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(completePaidPharmacySale).not.toHaveBeenCalled();
  });
  it.each([false, true])('honors the locked branch skip policy (%s)', async (allowSkip) => {
    const input = { ...base, type: 'RAAST' as const, referenceSkipped: true };
    const { db, scoped } = fixture(input, allowSkip);
    const result = applyPharmacyTender(scoped, scope, input);
    if (allowSkip) {
      await expect(result).resolves.toMatchObject({ settled: true });
      expect(db.pharmacyTender.create).toHaveBeenCalledWith({ data: expect.objectContaining({ referenceSkipped: true, providerRef: undefined }) });
    } else await expect(result).rejects.toMatchObject({ reason: 'INVALID_MANUAL_CAPTURE' });
  });
});
