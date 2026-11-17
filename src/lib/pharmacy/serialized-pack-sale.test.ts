import { describe, expect, it, vi } from 'vitest';

import { parseDefaultPackSize } from './medicine';
import { addSaleLine, changeSaleStatus } from './sales';
import {
  claimSoldPackSerial,
  PharmacySerializedPackError,
  releaseSoldPackSerials,
  resolveSerializedPackForSale,
  SERIALIZED_PACK_APPROVAL_POLICY,
} from './serialized-pack-sale';

// The persisted regulatory gate has its own suites (regulatory.test.ts, sale-regulatory-gate.test.ts).
vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
const GS = '\u001d';
const NOW = new Date('2026-10-21T00:00:00.000Z');

// DEV-92 fixtures: primary packs sold without a box carry their own DataMatrix.
const SYRUP_GTIN = '08961234500013';
const SYRUP_BOTTLE = `]d201${SYRUP_GTIN}1727123110SYR-0425${GS}21A1B2C3D4E5F6`;
const CREAM_GTIN = '08961234500020';
const CREAM_TUBE = `]d201${CREAM_GTIN}1728063010CRM-77${GS}210F1E2D3C4B5A`;

type Claim = {
  gtin: string;
  serialKey: string;
  saleId: string;
  releasedAt: Date | null;
  [key: string]: unknown;
};

function lot(id: string, expiresAt: string) {
  return {
    id,
    packLevelId: 'pack-bottle',
    unitsPerPack: 1,
    printedMrpMinor: 25_000,
    unitCostMinor: 18_000,
    receivedAt: new Date('2026-09-01T00:00:00Z'),
    batch: { batchNumber: id === 'lot-scanned' ? 'SYR-0425' : 'SYR-0101', expiresAt },
  };
}

/**
 * A branch holding two lots of one syrup: FEFO would choose `lot-fefo`, the
 * scanned bottle came from `lot-scanned`. The sold-serial table enforces its
 * live unique key the way the partial index does.
 */
function saleDb(
  options: {
    received?: { branchId: string; inventoryLotId: string } | null;
    barcodeMedicineId?: string;
    batchLot?: { id: string } | null;
  } = {}
) {
  const claims: Claim[] = [];
  const lots = [lot('lot-fefo', '2027-01-31'), lot('lot-scanned', '2027-12-31')];
  const candidates = lots.map((entry) => ({
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    inventoryLotId: entry.id,
    stockLocationId: 'shelf-a',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date(`${entry.batch.expiresAt}T00:00:00Z`),
    receivedAt: entry.receivedAt,
    availableUnits: 5,
    unitsPerPack: 1,
    sealedPacks: 5,
    looseUnits: 0,
  }));
  let status = 'OPEN';
  let lineCount = 0;
  const db = {
    $queryRaw: vi.fn(async () => candidates),
    medicineBarcode: {
      findFirst: vi.fn(async () => ({
        presentation: { medicineId: options.barcodeMedicineId ?? 'medicine-syrup' },
      })),
    },
    pharmacyGoodsReceiptLine: {
      findFirst: vi.fn(async () =>
        options.received === undefined
          ? { branchId: scope.branchId, inventoryLotId: 'lot-scanned' }
          : options.received
      ),
    },
    pharmacyInventoryLot: {
      findFirst: vi.fn(async () =>
        options.batchLot === undefined ? { id: 'lot-scanned' } : options.batchLot
      ),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        lots.filter((entry) => where.id.in.includes(entry.id))
      ),
    },
    pharmacySoldPackSerial: {
      findFirst: vi.fn(
        async ({ where }: { where: Claim }) =>
          claims.find(
            (claim) =>
              claim.gtin === where.gtin &&
              claim.serialKey === where.serialKey &&
              claim.releasedAt === null
          ) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Claim }) => {
        if (
          claims.some(
            (claim) =>
              claim.gtin === data.gtin &&
              claim.serialKey === data.serialKey &&
              claim.releasedAt === null
          )
        )
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        const row = { ...data, releasedAt: null };
        claims.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Claim; data: { releasedAt: Date } }) => {
        const live = claims.filter(
          (claim) => claim.saleId === where.saleId && claim.releasedAt === null
        );
        for (const claim of live) claim.releasedAt = data.releasedAt;
        return { count: live.length };
      }),
    },
    pharmacyAllocationOverride: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'override-a',
        ...data,
      })),
    },
    pharmacyStockMovement: {
      create: vi.fn(async ({ data }: { data: { idempotencyKey: string } }) => ({
        ...data,
        id: `movement:${data.idempotencyKey}`,
      })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    pharmacySale: {
      findFirst: vi.fn(async () => ({ id: 'sale-a', status, lines: [] })),
      updateMany: vi.fn(
        async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
          if (status !== where.status) return { count: 0 };
          status = data.status;
          return { count: 1 };
        }
      ),
    },
    medicine: {
      findFirst: vi.fn(async () => ({
        id: 'medicine-syrup',
        saleable: true,
        rx: false,
        restricted: false,
        controlled: false,
      })),
    },
    // The bottle is its own sellable pack: one unit, no carton level above it.
    packLevel: {
      findMany: vi.fn(async () => [
        {
          id: 'pack-bottle',
          level: 'UNIT',
          parentPackLevelId: null,
          unitsPerParent: 1,
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          effectiveTo: null,
          versionGroupId: 'pack-bottle',
        },
      ]),
    },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacySaleLine: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `sale-line-${++lineCount}`,
        ...data,
      })),
    },
    pharmacySaleLineAllocation: {
      create: vi.fn(),
      findMany: vi.fn(async () => []),
    },
    pharmacyControlledRegisterEntry: { findMany: vi.fn(async () => []) },
    // No payment was taken on the bill, so it may be voided.
    pharmacyTender: { findMany: vi.fn(async () => []) },
    pharmacySaleEvent: { create: vi.fn() },
  };
  return { db, claims };
}

/** The server-verified manager PIN approval the router attaches to an out-of-order scan. */
const MANAGER_APPROVAL = 'MANAGER_PIN:manager-a';

function bottleLine(
  payload = SYRUP_BOTTLE,
  key = 'line-a',
  fefoApprovalPolicy: string | null = MANAGER_APPROVAL
) {
  return {
    saleId: 'sale-a',
    medicineId: 'medicine-syrup',
    presentationId: 'presentation-syrup',
    packLevelId: 'pack-bottle',
    saleUnit: 'PACK' as const,
    quantity: 1,
    canonicalUnitsPerSaleUnit: 1,
    scannedPack: { payload, ...(fefoApprovalPolicy ? { fefoApprovalPolicy } : {}) },
    idempotencyKey: key,
  };
}

describe('DEV-92 primary-pack setup', () => {
  it.each(['120 ml bottle', '30 g tube'])(
    'sets up "%s" as one sellable primary pack with no carton level',
    (pack) => {
      expect(parseDefaultPackSize(pack)).toEqual({ level: 'UNIT', unitsPerParent: 1 });
    }
  );
});

describe('DEV-92 serialized pack resolution', () => {
  it('pins the lot goods-in created for the scanned bottle serial', async () => {
    const { db } = saleDb();
    await expect(
      resolveSerializedPackForSale(
        db as never,
        scope,
        { medicineId: 'medicine-syrup', payload: SYRUP_BOTTLE },
        NOW
      )
    ).resolves.toEqual({
      gtin: SYRUP_GTIN,
      serialNumber: 'A1B2C3D4E5F6',
      serialKey: 'A1B2C3D4E5F6',
      inventoryLotId: 'lot-scanned',
    });
    expect(db.pharmacyGoodsReceiptLine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          gtin: SYRUP_GTIN,
          serialKey: 'A1B2C3D4E5F6',
          medicineId: 'medicine-syrup',
        }),
      })
    );
  });

  it('falls back to the branch lot of the printed batch for a cream tube received by hand', async () => {
    const { db } = saleDb({ received: null, barcodeMedicineId: 'medicine-syrup' });
    const pack = await resolveSerializedPackForSale(
      db as never,
      scope,
      { medicineId: 'medicine-syrup', payload: CREAM_TUBE },
      NOW
    );
    expect(pack).toMatchObject({
      gtin: CREAM_GTIN,
      serialKey: '0F1E2D3C4B5A',
      inventoryLotId: 'lot-scanned',
    });
    expect(db.pharmacyInventoryLot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          branchId: 'branch-a',
          batch: { medicineId: 'medicine-syrup', batchNumber: 'CRM-77' },
          // Only a lot that still holds sellable stock of the batch is chosen.
          balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
        },
      })
    );
  });

  it('does not pin a lot that goods-in recorded at another branch', async () => {
    const { db } = saleDb({ received: { branchId: 'branch-b', inventoryLotId: 'lot-elsewhere' } });
    const pack = await resolveSerializedPackForSale(
      db as never,
      scope,
      { medicineId: 'medicine-syrup', payload: SYRUP_BOTTLE },
      NOW
    );
    expect(pack.inventoryLotId).toBe('lot-scanned');
    expect(db.pharmacyInventoryLot.findFirst).toHaveBeenCalled();
  });

  it.each([
    ['a code without a serial', `]d201${SYRUP_GTIN}1727123110SYR-0425`],
    ['a legacy EAN-13', '8961234500013'],
    [
      'a GS1-128 carton of several packs',
      `]C100008961234000001233${'02'}${SYRUP_GTIN}17271231${'10'}SYR-0425${GS}3724`,
    ],
  ])('refuses %s as a serialized pack', async (_, payload) => {
    const { db } = saleDb();
    await expect(
      resolveSerializedPackForSale(db as never, scope, { medicineId: 'medicine-syrup', payload })
    ).rejects.toMatchObject({ reason: 'SERIAL_NOT_READABLE' });
  });

  it('refuses a pack whose serial and printed batch match no stocked lot here', async () => {
    const { db } = saleDb({ received: null, batchLot: null });
    await expect(
      resolveSerializedPackForSale(db as never, scope, {
        medicineId: 'medicine-syrup',
        payload: SYRUP_BOTTLE,
      })
    ).rejects.toMatchObject({ reason: 'SERIAL_LOT_UNAVAILABLE' });
  });

  it('never falls back to FEFO for an unidentified pack at the counter', async () => {
    const { db } = saleDb({ received: null, batchLot: null });
    await expect(addSaleLine(db as never, scope, bottleLine())).rejects.toMatchObject({
      reason: 'SERIAL_LOT_UNAVAILABLE',
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacySoldPackSerial.create).not.toHaveBeenCalled();
  });

  it('refuses a serial whose GTIN belongs to another medicine', async () => {
    const { db } = saleDb({ barcodeMedicineId: 'medicine-other' });
    await expect(
      resolveSerializedPackForSale(db as never, scope, {
        medicineId: 'medicine-syrup',
        payload: SYRUP_BOTTLE,
      })
    ).rejects.toMatchObject({ reason: 'SERIAL_MEDICINE_MISMATCH' });
  });

  it('turns a lost race on the live unique key into SERIAL_ALREADY_SOLD', async () => {
    const { db } = saleDb();
    const pack = {
      gtin: SYRUP_GTIN,
      serialNumber: 'a1b2c3d4e5f6',
      serialKey: 'A1B2C3D4E5F6',
      inventoryLotId: 'lot-scanned',
    };
    const sale = { saleId: 'sale-a', saleLineId: 'line-1', inventoryLotId: 'lot-scanned' };
    await claimSoldPackSerial(db as never, scope, pack, sale);
    const error = await claimSoldPackSerial(db as never, scope, pack, {
      ...sale,
      saleId: 'sale-b',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PharmacySerializedPackError);
    expect(error).toMatchObject({ reason: 'SERIAL_ALREADY_SOLD' });
  });
});

describe('DEV-92 counter sale of a serialized primary pack', () => {
  it('sells the scanned bottle from its own lot and claims its serial', async () => {
    const { db, claims } = saleDb();
    const { allocation } = await addSaleLine(db as never, scope, bottleLine());

    expect(allocation.allocations).toEqual([
      expect.objectContaining({ inventoryLotId: 'lot-scanned', units: 1 }),
    ]);
    // Not FEFO's choice, so the pinned lot carries override evidence naming the serial
    // and the approval that allowed it (DEV-843).
    expect(db.pharmacyAllocationOverride.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        selectedLotId: 'lot-scanned',
        recommendedLotId: 'lot-fefo',
        approvalPolicy: `${SERIALIZED_PACK_APPROVAL_POLICY}:${MANAGER_APPROVAL}`,
        reason: expect.stringContaining('A1B2C3D4E5F6'),
      }),
    });
    expect(claims).toEqual([
      expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        gtin: SYRUP_GTIN,
        serialNumber: 'A1B2C3D4E5F6',
        serialKey: 'A1B2C3D4E5F6',
        saleId: 'sale-a',
        saleLineId: 'sale-line-1',
        inventoryLotId: 'lot-scanned',
        soldByUserId: 'cashier-a',
        releasedAt: null,
      }),
    ]);
  });

  // DEV-843: scanning a pack is not an approval to sell out of FEFO order.
  it('refuses an unapproved scan of a pack that is not from the earliest-expiry lot', async () => {
    const { db, claims } = saleDb();
    await expect(
      addSaleLine(db as never, scope, bottleLine(SYRUP_BOTTLE, 'line-a', null))
    ).rejects.toMatchObject({ reason: 'SERIAL_FEFO_APPROVAL_REQUIRED' });
    // Nothing past the allocation runs; the sale transaction rolls the allocation back.
    expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
    expect(db.pharmacySoldPackSerial.create).not.toHaveBeenCalled();
    expect(claims).toEqual([]);
  });

  it('sells an unapproved scan of a pack from the earliest-expiry lot with no override', async () => {
    const { db, claims } = saleDb({
      received: { branchId: scope.branchId, inventoryLotId: 'lot-fefo' },
    });
    const { allocation } = await addSaleLine(
      db as never,
      scope,
      bottleLine(SYRUP_BOTTLE, 'line-a', null)
    );
    expect(allocation.allocations).toEqual([
      expect.objectContaining({ inventoryLotId: 'lot-fefo', units: 1 }),
    ]);
    expect(allocation.overrideId).toBeNull();
    expect(db.pharmacyAllocationOverride.create).not.toHaveBeenCalled();
    expect(claims).toEqual([expect.objectContaining({ inventoryLotId: 'lot-fefo' })]);
  });

  it('does not let a pharmacist-approved batch override stand in for the manager PIN', async () => {
    const { db } = saleDb();
    await expect(
      addSaleLine(db as never, scope, {
        ...bottleLine(SYRUP_BOTTLE, 'line-a', null),
        override: {
          inventoryLotId: 'lot-scanned',
          reason: 'Customer asked',
          approvalPolicy: 'PHARMACIST_ON_DUTY',
        },
      })
    ).rejects.toMatchObject({ reason: 'SERIAL_FEFO_APPROVAL_REQUIRED' });
    expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
    expect(db.pharmacySoldPackSerial.create).not.toHaveBeenCalled();
  });

  it('refuses a second sale of the same serial before any stock moves', async () => {
    const { db } = saleDb();
    await addSaleLine(db as never, scope, bottleLine());
    const moves = db.pharmacyStockMovement.create.mock.calls.length;

    await expect(
      addSaleLine(
        db as never,
        scope,
        bottleLine(SYRUP_BOTTLE.replace('A1B2C3D4E5F6', 'a1b2c3d4e5f6'), 'line-b')
      )
    ).rejects.toMatchObject({ reason: 'SERIAL_ALREADY_SOLD' });
    expect(db.pharmacyStockMovement.create.mock.calls.length).toBe(moves);
    expect(db.pharmacySaleLine.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['more than one pack', { quantity: 2 }],
    ['a loose unit', { saleUnit: 'UNIT' as const }],
  ])('refuses a serialized scan sold as %s', async (_, change) => {
    const { db } = saleDb();
    await expect(
      addSaleLine(db as never, scope, { ...bottleLine(), ...change })
    ).rejects.toMatchObject({ reason: 'INVALID_QUANTITY' });
    expect(db.pharmacySoldPackSerial.create).not.toHaveBeenCalled();
  });

  it('refuses a manual batch override that disagrees with the scanned pack', async () => {
    const { db } = saleDb();
    await expect(
      addSaleLine(db as never, scope, {
        ...bottleLine(),
        override: { inventoryLotId: 'lot-fefo', reason: 'Shelf order', approvalPolicy: 'p' },
      })
    ).rejects.toMatchObject({ reason: 'SERIAL_LOT_UNAVAILABLE' });
  });

  it('releases the serial when the sale is voided, so the pack can be sold again', async () => {
    const { db, claims } = saleDb();
    await addSaleLine(db as never, scope, bottleLine());
    await changeSaleStatus(
      db as never,
      scope,
      'sale-a',
      'void',
      { kind: 'COUNTER', actorIsManager: true },
      'Customer cancelled'
    );

    expect(db.pharmacySoldPackSerial.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', branchId: 'branch-a', saleId: 'sale-a', releasedAt: null },
      data: { releasedAt: expect.any(Date) },
    });
    expect(claims[0]?.releasedAt).toBeInstanceOf(Date);
    await expect(
      resolveSerializedPackForSale(db as never, scope, {
        medicineId: 'medicine-syrup',
        payload: SYRUP_BOTTLE,
      })
    ).resolves.toMatchObject({ inventoryLotId: 'lot-scanned' });
  });

  it('release is scoped to the voided sale', async () => {
    const { db } = saleDb();
    await releaseSoldPackSerials(db as never, scope, 'sale-z');
    expect(db.pharmacySoldPackSerial.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ saleId: 'sale-z' }) })
    );
  });
});
