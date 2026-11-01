import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
const approval = vi.hoisted(() => ({ authorize: vi.fn(), can: vi.fn() }));
vi.mock('../solo-approval', () => ({ authorizeSoloApproval: approval.authorize }));
vi.mock('@/lib/abac', () => ({ can: approval.can }));
import {
  DEFAULT_MATERIALITY_THRESHOLD,
  missingAttributes,
  signOffOpeningSession,
  postOpeningSession,
} from './opening-stock';

/** A line with every required attribute present. */
function completeLine() {
  return {
    sourceRef: 'ABZ-000123',
    manufacturingBatchId: 'batch_1',
    batchNumber: 'B-77',
    expiryDate: new Date('2027-06-01T00:00:00.000Z'),
    expiryPrecision: 'MONTH' as const,
    printedMrpMinor: 25_000,
    unitCostMinor: 18_000,
    stockLocationId: 'loc_1',
    packLevelId: 'pack_1',
    unitsPerPack: 10,
    countedUnits: 40,
  };
}

describe('MIG-03 opening line completeness', () => {
  it('raises no exception when every required attribute is present', () => {
    expect(missingAttributes(completeLine())).toEqual([]);
  });

  it.each([
    ['sourceRef', 'MISSING_SOURCE_REF'],
    ['manufacturingBatchId', 'MISSING_BATCH'],
    ['batchNumber', 'MISSING_BATCH'],
    ['expiryDate', 'MISSING_EXPIRY'],
    ['expiryPrecision', 'MISSING_EXPIRY'],
    ['printedMrpMinor', 'MISSING_MRP'],
    ['unitCostMinor', 'MISSING_COST'],
    ['stockLocationId', 'MISSING_LOCATION'],
    ['packLevelId', 'MISSING_LOCATION'],
    ['unitsPerPack', 'MISSING_LOCATION'],
    ['countedUnits', 'MISSING_COUNT'],
  ] as const)('reports %s missing as %s', (attribute, bucket) => {
    const gaps = missingAttributes({ ...completeLine(), [attribute]: null });
    expect(gaps).toContain(bucket);
  });

  /**
   * MIG-02 acceptance: missing batch/expiry/MRP is never silently defaulted. The
   * pure check is the first of the three guards (service, this, and the CHECK on
   * `pharmacy_opening_stock_lines`).
   */
  it('reports every gap at once rather than stopping at the first', () => {
    const gaps = missingAttributes({
      ...completeLine(),
      batchNumber: null,
      manufacturingBatchId: null,
      expiryDate: null,
      printedMrpMinor: null,
    });
    expect(gaps.sort()).toEqual(['MISSING_BATCH', 'MISSING_EXPIRY', 'MISSING_MRP']);
  });

  it('treats a blank source reference as absent rather than as a value', () => {
    expect(missingAttributes({ ...completeLine(), sourceRef: '   ' })).toEqual([
      'MISSING_SOURCE_REF',
    ]);
  });

  /** A counted zero is a fact about the shelf, not a missing value. */
  it('accepts a counted quantity of zero as a real count', () => {
    expect(missingAttributes({ ...completeLine(), countedUnits: 0 })).toEqual([]);
  });
});

describe('D05 materiality threshold default', () => {
  it('defaults to zero, so every variance is material until the contract sets one', () => {
    expect(DEFAULT_MATERIALITY_THRESHOLD).toEqual({
      thresholdMinor: BigInt(0),
      thresholdUnits: 0,
    });
  });
});

describe('opening stock solo sign-off', () => {
  const scope = { organizationId: 'org', branchId: 'branch', actorId: 'owner' };
  function fixture() {
    return {
      organization: { findFirstOrThrow: vi.fn(async () => ({ pharmacyOperatingMode: 'SOLO' })) },
      $queryRaw: vi.fn(async () => []),
      pharmacyOpeningSession: {
        findFirst: vi.fn(async () => ({
          id: 'session',
          status: 'POSTED',
          createdByActorId: 'owner',
        })),
        update: vi.fn(async ({ data }: { data: { status: string; signedOffBy: string } }) => data),
      },
      pharmacyMaterialityThreshold: { findFirst: vi.fn(async () => null) },
      pharmacyOpeningStockLine: { findMany: vi.fn(async () => []) },
      pharmacyOpeningException: { count: vi.fn(async () => 0) },
    };
  }
  it('requires authorized solo PIN proof before self sign-off', async () => {
    const db = fixture();
    approval.can.mockResolvedValue(true);
    approval.authorize.mockResolvedValue(false);
    await expect(signOffOpeningSession(db as never, scope, 'session')).rejects.toMatchObject({
      reason: 'COAUTH_REQUIRED',
    });
    expect(db.pharmacyOpeningSession.update).not.toHaveBeenCalled();
    approval.authorize.mockResolvedValue(true);
    await expect(
      signOffOpeningSession(db as never, scope, 'session', '1234')
    ).resolves.toMatchObject({ status: 'SIGNED_OFF', signedOffBy: 'owner' });
    expect(approval.authorize).toHaveBeenLastCalledWith(
      db,
      scope,
      { type: 'PharmacyOpeningSession', id: 'session' },
      '1234'
    );
  });
  it('keeps explicit DENY and unresolved exceptions stronger than a valid PIN', async () => {
    const db = fixture();
    approval.can.mockResolvedValue(false);
    approval.authorize.mockClear().mockResolvedValue(true);
    await expect(
      signOffOpeningSession(db as never, scope, 'session', '1234')
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    expect(approval.authorize).not.toHaveBeenCalled();
    approval.can.mockResolvedValue(true);
    db.pharmacyOpeningException.count.mockResolvedValue(1);
    await expect(
      signOffOpeningSession(db as never, scope, 'session', '1234')
    ).rejects.toMatchObject({ reason: 'OPEN_EXCEPTIONS' });
    expect(db.pharmacyOpeningSession.update).not.toHaveBeenCalled();
  });
});

const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };

function openingDb(precision: 'DAY' | 'MONTH', stored: string) {
  const db = {
    pharmacyOpeningSession: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'session',
        branchId: SCOPE.branchId,
        status: 'COUNTED',
        openingAt: new Date('2026-10-21T00:00:00.000Z'),
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyOpeningStockLine: {
      findMany: vi.fn().mockResolvedValue([
        {
          ...completeLine(),
          id: 'line',
          expiryDate: new Date('2027-06-15T00:00:00.000Z'),
          expiryPrecision: precision,
        },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyManufacturingBatch: {
      findFirst: vi.fn().mockResolvedValue({ expiresAt: new Date(stored) }),
    },
    pharmacyInventoryLot: { create: vi.fn().mockResolvedValue({ id: 'lot' }) },
    pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement' }) },
    pharmacyOpeningTotal: {
      create: vi.fn().mockImplementation(async ({ data }: { data: object }) => data),
    },
  };
  return { db: db as unknown as ScopedDb, models: db };
}

describe('opening stock expiry boundaries', () => {
  it.each([
    ['DAY', '2027-06-16T00:00:00.000Z', '2027-06-15T19:00:00.000Z'],
    ['DAY', '2027-06-15T19:00:00.000Z', '2027-06-15T19:00:00.000Z'],
    ['MONTH', '2027-07-01T00:00:00.000Z', '2027-06-30T19:00:00.000Z'],
    ['MONTH', '2027-06-30T19:00:00.000Z', '2027-06-30T19:00:00.000Z'],
  ] as const)('posts %s stock against an existing batch at %s', async (precision, stored, pkt) => {
    const { db, models } = openingDb(precision, stored);

    const posted = await postOpeningSession(db, SCOPE, {
      sessionId: 'session',
      idempotencyKeyPrefix: 'opening',
    });

    expect(posted.postedLineCount).toBe(1);
    expect(posted.total).toMatchObject({ totalUnits: 40, totalValueMinor: BigInt(720_000) });
    expect(models.pharmacyInventoryLot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        manufacturingBatchId: 'batch_1',
        receivedExpiresAt: new Date(pkt),
        receivedExpiryPrecision: precision,
      }),
    });
    expect(models.pharmacyManufacturingBatch.findFirst).toHaveBeenCalledWith({
      where: { id: 'batch_1', organizationId: SCOPE.organizationId },
      select: { expiresAt: true },
    });
  });

  it.each([
    ['DAY', '2027-06-17T00:00:00.000Z'],
    ['MONTH', '2027-07-02T00:00:00.000Z'],
    ['DAY', '2027-06-15T19:00:00.001Z'],
  ] as const)('refuses a conflicting %s batch expiry at %s', async (precision, stored) => {
    const { db, models } = openingDb(precision, stored);

    await expect(
      postOpeningSession(db, SCOPE, { sessionId: 'session', idempotencyKeyPrefix: 'opening' })
    ).rejects.toMatchObject({ reason: 'BATCH_EXPIRY_CONFLICT' });
    expect(models.pharmacyInventoryLot.create).not.toHaveBeenCalled();
    expect(models.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(models.pharmacyOpeningSession.update).not.toHaveBeenCalled();
  });

  it('refuses a batch outside the workspace before posting stock', async () => {
    const { db, models } = openingDb('DAY', '2027-06-16T00:00:00.000Z');
    models.pharmacyManufacturingBatch.findFirst.mockResolvedValue(null);

    await expect(
      postOpeningSession(db, SCOPE, { sessionId: 'session', idempotencyKeyPrefix: 'opening' })
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(models.pharmacyInventoryLot.create).not.toHaveBeenCalled();
    expect(models.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});
