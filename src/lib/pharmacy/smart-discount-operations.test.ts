import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifySmartDiscountOwner, isSmartDiscountApproval } from './smart-discount-approval';
import {
  assertSmartDiscountOwner,
  readSmartDiscountSuggestion,
  recordCompetitorDiscountObservation,
  saveSmartDiscountPolicy,
} from './smart-discount-operations';
import { validateDiscount } from './sales';

vi.mock('@/lib/restaurant/operator-credentials', async (original) => ({
  ...(await original<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: vi.fn(async (_type: string, pin: string) => pin === '1234'),
}));
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
const policy = { minimumMarginBps: 2000, minimumObservations: 3, targetDemandLiftBps: 1000 };
function fixture() {
  const user = { id: 'owner', organizationId: 'org', role: 'ADMIN', status: 'ACTIVE' };
  const credential = {
    id: 'credential',
    failedAttempts: 0,
    lockedUntil: null,
    credentialHash: 'hash',
    staffProfile: { status: 'ACTIVE', user },
  };
  return {
    $queryRaw: vi.fn(async () => [{ allowed: true }]),
    user: { findFirst: vi.fn(async () => user) },
    pharmacyBranch: { findFirst: vi.fn(async () => ({ id: 'branch' })) },
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => credential),
      update: vi.fn(async () => ({})),
    },
    pharmacySmartDiscountPolicy: {
      findUnique: vi.fn(async () => policy),
      upsert: vi.fn(async () => policy),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    packLevel: { findFirst: vi.fn(async () => ({ id: 'pack' })) },
    pharmacyCompetitorDiscountObservation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findMany: vi.fn(async () =>
        [1000, 900, 800].map((price, i) => ({
          competitorPriceMinor: price,
          observedDemandUnits: 10 + 5 * i,
        }))
      ),
    },
    pharmacyInventoryLot: {
      findFirst: vi.fn(async () => ({
        id: 'lot',
        packLevelId: 'pack',
        printedMrpMinor: 1000,
        unitsPerPack: 10,
        unitCostMinor: 76,
        batch: {
          medicineId: 'medicine',
          medicine: { rx: false, restricted: false, controlled: false },
        },
      })),
    },
  };
}
describe('persisted smart discount workflow', () => {
  beforeEach(() => vi.clearAllMocks());
  it('requires current owner and branch access', async () => {
    const db = fixture();
    await assertSmartDiscountOwner(db as never, scope);
    db.$queryRaw.mockResolvedValue([{ allowed: false }]);
    await expect(assertSmartDiscountOwner(db as never, scope)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'actor', organizationId: 'org', role: 'ADMIN', status: 'ACTIVE' },
    });
  });
  it('saves an explicit policy and its audit in the caller transaction', async () => {
    const db = fixture();
    await saveSmartDiscountPolicy(db as never, scope, policy);
    expect(db.pharmacySmartDiscountPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { ...policy, organizationId: 'org', branchId: 'branch', updatedById: 'actor' },
      })
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actorId: 'actor', targetId: 'branch' }),
      })
    );
  });
  it('logs evidence only for the matching tenant medicine and pack', async () => {
    const db = fixture();
    const input = {
      medicineId: 'medicine',
      packLevelId: 'pack',
      competitor: 'Nearby store',
      competitorPriceMinor: 900,
      observedDemandUnits: 12,
      observedAt: new Date(),
    };
    await recordCompetitorDiscountObservation(db as never, scope, input);
    expect(db.pharmacyCompetitorDiscountObservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ...scope, ...input }),
    });
    db.packLevel.findFirst.mockResolvedValue(null as never);
    await expect(
      recordCompetitorDiscountObservation(db as never, scope, input)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyCompetitorDiscountObservation.create).toHaveBeenCalledTimes(1);
  });
  it('uses stored pack evidence and lot cost for a margin-bounded quote', async () => {
    const db = fixture();
    expect(await readSmartDiscountSuggestion(db as never, scope, 'lot')).toMatchObject({
      packLevelId: 'pack',
      canonicalUnitsInPack: 10,
      genericWhatsAppText:
        'Save 5% on an eligible retail purchase in store. Terms apply. Reply STOP to opt out.',
      suggestion: { eligible: true, minimumAllowedPriceMinor: 950, suggestedPriceMinor: 950 },
    });
    expect(db.pharmacyCompetitorDiscountObservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org',
          branchId: 'branch',
          medicineId: 'medicine',
          packLevelId: 'pack',
        },
      })
    );
    const lot = await db.pharmacyInventoryLot.findFirst();
    lot.batch.medicine.rx = true;
    db.pharmacyInventoryLot.findFirst.mockResolvedValue(lot);
    expect(await readSmartDiscountSuggestion(db as never, scope, 'lot')).toMatchObject({
      suggestion: { eligible: false, reason: 'RX_ONLY' },
      genericWhatsAppText: null,
    });
  });
  it('enforces the exact margin boundary with integer arithmetic', () => {
    const input = {
      regulated: false,
      grossMinor: 1000,
      costMinor: 760,
      approvedByUserId: 'owner',
      approvalPolicy: 'approved',
      minimumMarginBps: 2000,
    };
    expect(() => validateDiscount({ ...input, discountMinor: 200 })).toThrow('MARGIN_GUARDRAIL');
    expect(() => validateDiscount({ ...input, discountMinor: 51 })).toThrow('MARGIN_GUARDRAIL');
    expect(() => validateDiscount({ ...input, discountMinor: 50 })).not.toThrow();
  });
  it('returns a denial with a persisted failed-attempt increment, never a proof', async () => {
    const db = fixture();
    expect(
      await verifySmartDiscountOwner(db as never, scope, { staffProfileId: 'staff', pin: '9999' })
    ).toHaveProperty('blocked');
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential' },
      data: { failedAttempts: 1, lockedUntil: null },
    });
  });
  it('binds a verified owner proof to this scope and rejects serialized forgeries', async () => {
    const result = await verifySmartDiscountOwner(fixture() as never, scope, {
      staffProfileId: 'staff',
      pin: '1234',
    });
    expect(result).toHaveProperty('approval');
    if (!('approval' in result)) throw new Error('Expected verified proof');
    expect(isSmartDiscountApproval(result.approval, scope)).toBe(true);
    expect(isSmartDiscountApproval({ ...result.approval }, scope)).toBe(false);
    expect(isSmartDiscountApproval(result.approval, { ...scope, branchId: 'sibling' })).toBe(false);
    expect(JSON.stringify(result)).not.toContain('1234');
  });
  it.each(['EMPLOYEE', 'INACTIVE', 'LOCKED'])(
    'rejects %s owners before PIN verification',
    async (state) => {
      const db = fixture();
      const credential = await db.restaurantOperatorCredential.findFirst();
      if (state === 'EMPLOYEE') credential.staffProfile.user.role = 'EMPLOYEE';
      if (state === 'INACTIVE') credential.staffProfile.user.status = 'SUSPENDED';
      if (state === 'LOCKED') credential.lockedUntil = new Date(Date.now() + 60_000) as never;
      db.restaurantOperatorCredential.findFirst.mockResolvedValue(credential);
      expect(
        await verifySmartDiscountOwner(db as never, scope, { staffProfileId: 'staff', pin: '1234' })
      ).toHaveProperty('blocked');
      expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
    }
  );
});
