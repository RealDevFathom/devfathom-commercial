import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { shelfLabelCode } from './shelf-label-code';
import { printedExpiry, readShelfLabelSources, shelfPacksFor } from './shelf-label-source';

const scope = { organizationId: 'org_a', branchId: 'branch_a' };
const AT = new Date('2026-10-31T09:00:00.000Z');

const packLevels = [
  { id: 'box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 },
  { id: 'strip', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 3 },
  { id: 'tab', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10 },
];

function lot(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    shelfLabelNumber: 7,
    packLevelId: 'box',
    unitsPerPack: 30,
    printedMrpMinor: 3001,
    receivedExpiresAt: new Date('2027-06-30T19:00:00.000Z'),
    receivedExpiryPrecision: 'MONTH',
    batch: {
      batchNumber: 'B-1',
      medicine: {
        productName: 'Loose Strip',
        strengths: [{ value: '500.000000', unit: 'mg' }],
      },
    },
    packLevel: { presentation: { packLevels } },
    ...overrides,
  };
}

function makeDb(options: {
  receipt?: unknown;
  lots?: unknown[];
  price?: { mrpMinor: number } | null;
}) {
  const findMany = vi.fn().mockResolvedValue(options.lots ?? []);
  return {
    db: {
      medicineBarcode: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyGoodsReceipt: { findFirst: vi.fn().mockResolvedValue(options.receipt ?? null) },
      pharmacyInventoryLot: { findMany },
      pharmacyPackPrice: { findFirst: vi.fn().mockResolvedValue(options.price ?? null) },
    } as unknown as ScopedDb,
    findMany,
  };
}

describe('#719 shelf-label source', () => {
  it('counts one label per accepted pack, bonus included and rejects excluded', () => {
    expect(shelfPacksFor(120, 30)).toBe(4);
    expect(shelfPacksFor(125, 30)).toBe(5);
    expect(shelfPacksFor(0, 30)).toBe(0);
    expect(shelfPacksFor(10, 0)).toBe(0);
  });

  it('prints the PKT calendar expiry, including legacy UTC-midnight boundaries', () => {
    expect(printedExpiry(new Date('2027-06-30T19:00:00.000Z'), 'MONTH')).toBe('2027-06');
    expect(printedExpiry(new Date('2027-06-15T19:00:00.000Z'), 'DAY')).toBe('2027-06-15');
    expect(printedExpiry(new Date('2027-07-01T00:00:00.000Z'), 'MONTH')).toBe('2027-06');
    expect(printedExpiry(new Date('2027-06-16T00:00:00.000Z'), 'DAY')).toBe('2027-06-15');
  });

  it('defaults a GRN to one label per received pack and prints the lot MRP the counter charges', async () => {
    const { db, findMany } = makeDb({
      receipt: {
        lines: [
          { inventoryLotId: 'lot_1', acceptedCanonicalUnits: 300, canonicalUnitsPerPack: 30 },
          { inventoryLotId: 'lot_1', acceptedCanonicalUnits: 60, canonicalUnitsPerPack: 30 },
          { inventoryLotId: null, acceptedCanonicalUnits: 0, canonicalUnitsPerPack: 30 },
        ],
      },
      lots: [lot('lot_1')],
    });
    // A router passes its LedgerScope; the actor must never reach a where clause.
    const ledgerScope = { ...scope, actorId: 'user_a' };
    const { rows, next } = await readShelfLabelSources(db, ledgerScope, { goodsReceiptId: 'grn_1' }, AT);
    const receiptQuery = (db.pharmacyGoodsReceipt.findFirst as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(receiptQuery.where).toEqual({
      organizationId: 'org_a',
      branchId: 'branch_a',
      id: 'grn_1',
      status: 'POSTED',
    });
    expect(receiptQuery.select.lines.where).toEqual(scope);
    expect(next).toBeNull();
    expect(rows).toEqual([
      {
        inventoryLotId: 'lot_1',
        code: shelfLabelCode(7),
        unavailableReason: null,
        name: 'Loose Strip',
        strength: '500 mg',
        packMrpMinor: 3001,
        stripMrpMinor: 1000,
        priceRecordMrpMinor: null,
        expiry: '2027-06',
        batchNumber: 'B-1',
        count: 12,
      },
    ]);
    const where = findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      organizationId: 'org_a',
      branchId: 'branch_a',
      receivedAt: { not: null },
      id: { in: ['lot_1'] },
    });
  });

  it('flags, but never prints, a pack-price record that disagrees with the lot MRP', async () => {
    const { db } = makeDb({ lots: [lot('lot_1')], price: { mrpMinor: 3500 } });
    const { rows } = await readShelfLabelSources(db, scope, {}, AT);
    expect(rows[0]).toMatchObject({ packMrpMinor: 3001, priceRecordMrpMinor: 3500, count: 1 });
  });

  it('does not invent a strip price when the pack hierarchy disagrees with the lot', async () => {
    const { db } = makeDb({ lots: [lot('lot_1', { unitsPerPack: 25 })] });
    const { rows } = await readShelfLabelSources(db, scope, {}, AT);
    expect(rows[0]!.stripMrpMinor).toBeNull();
  });

  it('prices the actual strip below a carton and box, regardless of pack-level order', async () => {
    const cartonLevels = [
      { id: 'carton', level: 'CARTON', parentPackLevelId: null, unitsPerParent: 1 },
      { ...packLevels[0]!, parentPackLevelId: 'carton', unitsPerParent: 10 },
      packLevels[1]!,
      packLevels[2]!,
    ];
    const { db } = makeDb({ lots: [lot('lot_1', {
      packLevelId: 'carton',
      unitsPerPack: 300,
      printedMrpMinor: 30_000,
      packLevel: { presentation: { packLevels: cartonLevels.reverse() } },
    })] });
    const { rows } = await readShelfLabelSources(db, scope, {}, AT);
    expect(rows[0]).toMatchObject({ packMrpMinor: 30_000, stripMrpMinor: 1000 });
  });

  it.each([
    ['within a hierarchy', packLevels],
    ['standalone', [{ id: 'strip', level: 'STRIP', parentPackLevelId: null, unitsPerParent: 10 }]],
  ])('uses the lot MRP when the received pack is a strip %s', async (_label, levels) => {
    const { db } = makeDb({ lots: [lot('lot_1', {
      packLevelId: 'strip', unitsPerPack: 10, printedMrpMinor: 1001,
      packLevel: { presentation: { packLevels: levels } },
    })] });
    const { rows } = await readShelfLabelSources(db, scope, {}, AT);
    expect(rows[0]).toMatchObject({ packMrpMinor: 1001, stripMrpMinor: 1001 });
  });

  it('does not relabel an intermediate box as a strip when no strip level exists', async () => {
    const { db } = makeDb({ lots: [lot('lot_1', {
      packLevelId: 'carton',
      unitsPerPack: 300,
      packLevel: { presentation: { packLevels: [
        { id: 'carton', level: 'CARTON', parentPackLevelId: null, unitsPerParent: 1 },
        { id: 'box', level: 'BOX', parentPackLevelId: 'carton', unitsPerParent: 10 },
        { id: 'tab', level: 'UNIT', parentPackLevelId: 'box', unitsPerParent: 30 },
      ] } },
    })] });
    const { rows } = await readShelfLabelSources(db, scope, {}, AT);
    expect(rows[0]!.stripMrpMinor).toBeNull();
  });

  it('refuses a GRN that is not posted in this branch', async () => {
    const { db } = makeDb({ receipt: null });
    await expect(
      readShelfLabelSources(db, scope, { goodsReceiptId: 'grn_x' }, AT)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a printed lot that is outside the GRN, the branch or not yet received', async () => {
    const receipt = {
      lines: [{ inventoryLotId: 'lot_1', acceptedCanonicalUnits: 30, canonicalUnitsPerPack: 30 }],
    };
    await expect(
      readShelfLabelSources(
        makeDb({ receipt, lots: [lot('lot_1')] }).db,
        scope,
        { goodsReceiptId: 'grn_1', inventoryLotIds: ['lot_other'] },
        AT
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      readShelfLabelSources(makeDb({ lots: [] }).db, scope, { inventoryLotIds: ['lot_9'] }, AT)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('searches a scanned label by its exact lot alias instead of fuzzy text', async () => {
    const { db, findMany } = makeDb({ lots: [] });
    await readShelfLabelSources(db, scope, { query: shelfLabelCode(7) }, AT);
    const where = findMany.mock.calls[0]![0].where;
    expect(where.shelfLabelNumber).toBe(7);
    expect(where.OR).toBeUndefined();
  });

  it('refuses to print a shelf code already owned by a registered barcode', async () => {
    const { db } = makeDb({ lots: [lot('lot_1')] });
    vi.mocked(db.medicineBarcode.findMany).mockResolvedValue([{ normalizedCode: shelfLabelCode(7) }] as never);
    await expect(readShelfLabelSources(db, scope, { inventoryLotIds: ['lot_1'] }, AT))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.medicineBarcode.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', normalizedCode: { in: [shelfLabelCode(7)] } },
      select: { normalizedCode: true },
    });
  });

  it('retains valid GRN selections when another lot has a barcode collision', async () => {
    const { db, findMany } = makeDb({
      receipt: { lines: [
        { inventoryLotId: 'lot_1', acceptedCanonicalUnits: 60, canonicalUnitsPerPack: 30 },
        { inventoryLotId: 'lot_2', acceptedCanonicalUnits: 90, canonicalUnitsPerPack: 30 },
      ] },
      lots: [lot('lot_1'), lot('lot_2', { shelfLabelNumber: 8 })],
    });
    vi.mocked(db.medicineBarcode.findMany).mockResolvedValue([{ normalizedCode: shelfLabelCode(7) }] as never);
    const { rows } = await readShelfLabelSources(db, scope, { goodsReceiptId: 'grn_1' }, AT);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ inventoryLotId: 'lot_1', count: 0, unavailableReason: expect.stringContaining('already registered') });
    expect(rows[1]).toMatchObject({ inventoryLotId: 'lot_2', count: 3, unavailableReason: null });

    // Only selected codes are checked when printing, so the valid lot can print.
    findMany.mockResolvedValue([lot('lot_2', { shelfLabelNumber: 8 })]);
    vi.mocked(db.medicineBarcode.findMany).mockResolvedValue([]);
    const printed = await readShelfLabelSources(db, scope, {
      goodsReceiptId: 'grn_1', inventoryLotIds: ['lot_2'],
    }, AT);
    expect(printed.rows[0]).toMatchObject({ inventoryLotId: 'lot_2', unavailableReason: null });
    expect(db.medicineBarcode.findMany).toHaveBeenLastCalledWith({
      where: { organizationId: 'org_a', normalizedCode: { in: [shelfLabelCode(8)] } },
      select: { normalizedCode: true },
    });
  });

  it('pages the medicine list 100 lots at a time even with multiple barcode collisions', async () => {
    const lots = Array.from({ length: 101 }, (_, index) =>
      lot(`lot_${String(index).padStart(3, '0')}`, { shelfLabelNumber: index + 1 })
    );
    const { db } = makeDb({ lots });
    vi.mocked(db.medicineBarcode.findMany).mockResolvedValue([
      { normalizedCode: shelfLabelCode(1) },
      { normalizedCode: shelfLabelCode(100) },
    ] as never);
    const { rows, next } = await readShelfLabelSources(db, scope, { query: 'loose' }, AT);
    expect(rows).toHaveLength(100);
    expect(next).toBe('lot_099');
    expect(rows[0]).toMatchObject({ count: 0, unavailableReason: expect.any(String) });
    expect(rows[99]).toMatchObject({ count: 0, unavailableReason: expect.any(String) });
    expect(rows[1]).toMatchObject({ count: 1, unavailableReason: null });
    expect(db.pharmacyInventoryLot.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101 }));

    vi.mocked(db.pharmacyInventoryLot.findMany).mockResolvedValue(lots.slice(100) as never);
    vi.mocked(db.medicineBarcode.findMany).mockResolvedValue([]);
    const following = await readShelfLabelSources(db, scope, { query: 'loose', after: next! }, AT);
    expect(following.rows).toHaveLength(1);
    expect(following.rows[0]).toMatchObject({ inventoryLotId: 'lot_100', count: 1 });
    expect(following.next).toBeNull();
    expect(db.pharmacyInventoryLot.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AND: [{ id: { gt: 'lot_099' } }] }),
    }));
  });
});
