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
vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));
vi.mock('./sale-completion', () => ({ completionSaleInclude: {}, completePaidPharmacySale: vi.fn(async () => 41) }));
import { applyPharmacyTender, readPharmacyTenderOutcome, type PharmacyPaymentAdapter } from './settlement';
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

const cardBase = { saleId: 'sale', deviceId: 'counter', businessDate: new Date('2026-11-15'), amountMinor: 1000, idempotencyKey: 'card-attempt', type: 'CARD' as const };
describe('DEV-713 manual card and wallet confirmation', () => {
  it('records a terminal card as received externally, with approval code and confirmer', async () => {
    const input = { ...cardBase, providerRef: '4242', approvalCode: 'A1B2C3' };
    const { db, scoped } = fixture(input);
    expect(await applyPharmacyTender(scoped, scope, input)).toMatchObject({ settled: true, receiptNumber: 41 });
    expect(db.pharmacyTender.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      type: 'CARD', provider: 'MANUAL_TERMINAL', providerRef: '4242', approvalCode: 'A1B2C3',
      confirmedById: 'cashier', actorId: 'cashier', payerName: undefined, drawerSessionId: undefined,
    }) });
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
  });
  it.each([
    { providerRef: '4242' },
    { approvalCode: 'A1B2' },
    { providerRef: '42', approvalCode: 'A1B2' },
    { providerRef: '4242', approvalCode: 'A1B2', payerName: 'Ayesha' },
    { providerRef: '4242', approvalCode: 'A1B2', cashReceivedMinor: 1000 },
    { providerRef: '4242424242424242', approvalCode: 'A1B2' },
  ])('refuses an incomplete manual card capture %j before any tender', async (capture) => {
    const input = { ...cardBase, ...capture };
    const { db, scoped } = fixture(input);
    await expect(applyPharmacyTender(scoped, scope, input)).rejects.toMatchObject({ reason: 'INVALID_MANUAL_CAPTURE' });
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(completePaidPharmacySale).not.toHaveBeenCalled();
  });
  it('keeps the integrated provider path separate: an uncertified adapter still refuses', async () => {
    const adapter: PharmacyPaymentAdapter = { name: 'ACQUIRER', certified: false, execute: vi.fn() };
    const input = { ...cardBase, adapter };
    const { db, scoped } = fixture(input);
    await expect(applyPharmacyTender(scoped, scope, input)).rejects.toMatchObject({ reason: 'UNCERTIFIED_PROVIDER' });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
    const withCode = { ...cardBase, adapter, providerRef: '4242', approvalCode: 'A1B2' };
    await expect(applyPharmacyTender(fixture(withCode).scoped, scope, withCode)).rejects.toMatchObject({ reason: 'INVALID_MANUAL_CAPTURE' });
  });
  it('still refuses a generic wallet without a provider', async () => {
    const input = { ...cardBase, type: 'WALLET' as const };
    const { db, scoped } = fixture(input);
    await expect(applyPharmacyTender(scoped, scope, input)).rejects.toMatchObject({ reason: 'UNCERTIFIED_PROVIDER' });
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
  });
  it('never records a wallet payment through Card: wallet capture on a card tender is refused', async () => {
    const input = { ...cardBase, providerRef: '001234', approvalCode: 'A1B2', payerName: 'Ayesha' };
    const { db, scoped } = fixture(input);
    await expect(applyPharmacyTender(scoped, scope, input)).rejects.toMatchObject({ reason: 'INVALID_MANUAL_CAPTURE' });
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
    // The same payment taken as a wallet is recorded as that wallet tender, with its provider type.
    const wallet = { ...base, type: 'JAZZCASH' as const, providerRef: '001234' };
    const walletFixture = fixture(wallet);
    await expect(applyPharmacyTender(walletFixture.scoped, scope, wallet)).resolves.toMatchObject({ settled: true });
    expect(walletFixture.db.pharmacyTender.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      type: 'JAZZCASH', provider: 'MANUAL_MERCHANT', providerRef: '001234', approvalCode: undefined,
    }) });
  });
  it('refuses an approval code on any other tender', async () => {
    const input = { ...cardBase, type: 'BANK_TRANSFER' as const, approvalCode: 'A1B2' };
    const { scoped } = fixture(input);
    await expect(applyPharmacyTender(scoped, scope, input)).rejects.toMatchObject({ reason: 'INVALID_MANUAL_CAPTURE' });
  });
  it.each(MANUAL_TENDER_TYPES)('records the confirmer of %s and accepts a branch with no merchant details', async (type) => {
    const input = { ...base, type, providerRef: '001234' };
    const { db, scoped } = fixture(input);
    db.pharmacyBranch.findFirst.mockResolvedValue({ manualPaymentSettings: { [type]: { allowReferenceSkip: false } }, manualPaymentRevision: 1 });
    await expect(applyPharmacyTender(scoped, scope, input)).resolves.toMatchObject({ settled: true });
    expect(db.pharmacyTender.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type, confirmedById: 'cashier', approvalCode: undefined }) });
  });
  it('treats a manual card outcome with a different approval code as unknown', async () => {
    const input = { ...cardBase, providerRef: '4242', approvalCode: 'A1B2C3' };
    const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const tender = { id: 'tender', organizationId: 'org', branchId: 'branch', saleId: 'sale', deviceId: 'counter', type: 'CARD', amountMinor: 1000, businessDate: cardBase.businessDate, cashReceivedMinor: null, changeGivenMinor: null, provider: 'MANUAL_TERMINAL', providerRef: '4242', payerName: null, referenceSkipped: false, approvalCode: 'A1B2C3', confirmedById: 'cashier' };
    const db = {
      pharmacySale: { findFirst: vi.fn().mockResolvedValue({ id: 'sale', organizationId: 'org', branchId: 'branch' }) },
      pharmacyMoneyIdempotencyKey: { findUnique: vi.fn().mockResolvedValue({ organizationId: 'org', deviceId: 'counter', key: 'card-attempt', commandType: 'tender', payloadHash: hashOf(input), resultPayload: { tenderId: 'tender', settled: true, receiptNumber: 41, remainingMinor: 0 } }) },
      pharmacyTender: { findFirst: vi.fn().mockResolvedValue(tender) },
    };
    expect(await readPharmacyTenderOutcome(db as unknown as ScopedDb, scope, input)).toMatchObject({ status: 'ACCEPTED' });
    db.pharmacyTender.findFirst.mockResolvedValue({ ...tender, approvalCode: 'ZZZZ' });
    expect(await readPharmacyTenderOutcome(db as unknown as ScopedDb, scope, input)).toMatchObject({ status: 'UNKNOWN' });
  });
});
