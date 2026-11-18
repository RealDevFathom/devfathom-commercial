import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));
const abac = vi.hoisted(() => ({ can: vi.fn(async () => true) }));
vi.mock('@/lib/abac', () => ({ can: abac.can }));
const batchSafety = vi.hoisted(() => ({
  assertSaleBatchesSellable: vi.fn(async () => {
    // Stops the payment right after the per-sale checks; the rest has its own suites.
    throw new Error('PAST_PER_SALE_CHECKS');
  }),
}));
vi.mock('./sale-batch-safety', () => ({
  assertSaleBatchesSellable: batchSafety.assertSaleBatchesSellable,
}));

import { applyPharmacyTender } from './settlement';

/**
 * DEV-905 (owner decision, 18 Nov): in a pharmacy a super admin approved, the regulatory
 * gate no longer refuses a prescription-only or controlled line for want of a profile or
 * a pharmacist on the roster. The per-sale rules are unchanged: the payer needs the
 * pharmacist dispensing grant, and an Rx line needs a pharmacist-attached prescription
 * and a signed pharmacist review, approved or not. The real regulatory gate runs here.
 */
const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'pharmacist-1' };

function line(medicine: { rx: boolean; controlled: boolean }, prescriptionLineId: string | null) {
  return {
    id: 'line-1',
    quantity: 1,
    unitPriceMinor: 100,
    discountMinor: 0,
    prescriptionLineId,
    medicine: {
      organizationId: 'org-1',
      productName: 'Medicine',
      rx: medicine.rx,
      restricted: false,
      controlled: medicine.controlled,
      strengths: [],
    },
  };
}

function tenderDb(
  saleLine: ReturnType<typeof line>,
  organization: { status: string; platformApprovedAt: Date | null },
  signedReview: boolean
) {
  return {
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        timezone: 'Asia/Karachi',
        vertical: 'PHARMACY',
        ...organization,
      }),
    },
    // No regulatory profile at all, so no qualified person either.
    branchRegulatoryProfile: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyPharmacistReviewDecision: {
      findFirst: vi.fn().mockResolvedValue(signedReview ? { id: 'review-1' } : null),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyMoneyIdempotencyKey: { findUnique: vi.fn(), update: vi.fn() },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'sale-1',
        status: 'OPEN',
        lines: [saleLine],
        tenders: [],
      }),
      update: vi.fn(),
    },
    pharmacyTender: { create: vi.fn() },
    pharmacySaleEvent: { create: vi.fn() },
    pharmacyDrawerMovement: { create: vi.fn() },
  };
}

async function pay(db: ReturnType<typeof tenderDb>) {
  const adapter = {
    name: 'CERTIFIED_TEST_PROVIDER',
    certified: true,
    execute: vi.fn().mockResolvedValue({ approved: true, providerRef: 'provider-1' }),
  };
  const input = {
    saleId: 'sale-1',
    deviceId: 'device-1',
    businessDate: new Date('2026-11-03T00:00:00.000Z'),
    type: 'CARD' as const,
    amountMinor: 100,
    idempotencyKey: 'approved-pharmacy-rx',
    adapter,
  };
  db.pharmacyMoneyIdempotencyKey.findUnique.mockResolvedValue({
    id: 'idem-1',
    commandType: 'tender',
    payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    resultPayload: null,
  });
  const outcome = await applyPharmacyTender(db as never, scope, input).catch((error) => error);
  return { outcome, adapter };
}

const APPROVED = { status: 'ACTIVE', platformApprovedAt: new Date('2026-11-02T09:00:00.000Z') };
const RX = { rx: true, controlled: false };
const CONTROLLED = { rx: false, controlled: true };

beforeEach(() => {
  vi.clearAllMocks();
  abac.can.mockResolvedValue(true);
});

describe('an approved pharmacy with no regulatory profile and no pharmacist', () => {
  it('sells a prescription-only line once the pharmacist has attached and signed it', async () => {
    const db = tenderDb(line(RX, 'rx-line-1'), APPROVED, true);
    const { outcome } = await pay(db);
    // Past the regulatory gate and every per-sale prescription check.
    expect(outcome).toMatchObject({ message: 'PAST_PER_SALE_CHECKS' });
    expect(batchSafety.assertSaleBatchesSellable).toHaveBeenCalled();
  });

  it('sells a controlled line, whose witness and register checks run at add-line', async () => {
    const db = tenderDb(line(CONTROLLED, null), APPROVED, false);
    const { outcome } = await pay(db);
    expect(outcome).toMatchObject({ message: 'PAST_PER_SALE_CHECKS' });
  });

  it.each([
    [
      'no prescription attached',
      line(RX, null),
      true,
      { name: 'PharmacyRxReferenceError', reason: 'PRESCRIPTION_REQUIRED' },
    ],
    [
      'no signed pharmacist review',
      line(RX, 'rx-line-1'),
      false,
      { name: 'PharmacyDispensingError', code: 'PHARMACIST_APPROVAL_REQUIRED' },
    ],
  ] as const)(
    'still refuses a prescription-only line with %s, before any payment',
    async (_label, saleLine, signedReview, refusal) => {
      const db = tenderDb(saleLine, APPROVED, signedReview);
      const { outcome, adapter } = await pay(db);
      expect(outcome).toMatchObject(refusal);
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(db.pharmacyTender.create).not.toHaveBeenCalled();
    }
  );

  it('still refuses a payer without the pharmacist dispensing grant', async () => {
    abac.can.mockResolvedValue(false);
    const db = tenderDb(line(RX, 'rx-line-1'), APPROVED, true);
    const { outcome, adapter } = await pay(db);
    expect(outcome).toMatchObject({ name: 'PharmacyRxSaleDenied' });
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});

describe('a pharmacy that is not approved, with no regulatory profile', () => {
  it.each([
    ['a prescription-only', RX, 'rx-line-1'],
    ['a controlled', CONTROLLED, null],
  ] as const)(
    'refuses %s line at the regulatory gate exactly as before',
    async (_kind, medicine, prescriptionLineId) => {
      const db = tenderDb(
        line(medicine, prescriptionLineId),
        { status: 'ACTIVE', platformApprovedAt: null },
        true
      );
      const { outcome, adapter } = await pay(db);
      expect(outcome).toMatchObject({
        name: 'BranchOperationDeniedError',
        reason: 'PROFILE_MISSING',
      });
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(batchSafety.assertSaleBatchesSellable).not.toHaveBeenCalled();
    }
  );
});
