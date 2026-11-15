import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { openingImportIdentity, previewOwnerImport, commitOwnerImport } from './owner-import';
import type { OwnerImportInput } from './owner-import-input';

const scope = { organizationId: 'org_owner', branchId: 'branch_owner', actorId: 'owner' };
const mapping = { sourceRef: 0, pack: 1, batch: 2, expiry: 3, mrp: 4, cost: 5, expected: 6, counted: 7, varianceNote: 8 };
function input(row = 'SRC-1,00123,B1,2099-06,25.00,1.25,12,10,Two damaged units excluded'): OwnerImportInput {
  return { fileName: 'stock.csv', content: Buffer.from(`Source,Pack,Batch,Expiry,MRP,Cost,Expected,Counted,Note\n${row}`).toString('base64'), branchId: scope.branchId, stockLocationId: 'location', mapping };
}
function makeDb() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: scope.branchId }) },
    pharmacyStockLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'location', coldChain: false }) },
    pharmacyOpeningSession: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    pharmacyOpeningTotal: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyStockMovement: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
    pharmacyManufacturingBatch: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    pharmacyInventoryLot: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    packLevel: { findMany: vi.fn().mockResolvedValue([{
      id: 'pack', presentation: { medicineId: 'medicine', medicine: { productName: 'Test', saleable: true, coldChain: false },
        packLevels: [{ id: 'pack', level: 'STRIP', unitsPerParent: 10, parentPackLevelId: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null }],
      },
    }]) },
  };
}
let db = makeDb();
const scoped = () => db as unknown as ScopedDb;
beforeEach(() => { db = makeDb(); });

describe('owner opening import dry run', () => {
  it('reports the exported/count diff and exact counted valuation without writes', async () => {
    const preview = await previewOwnerImport(scoped(), scope, input());
    expect(preview.canCommit).toBe(true);
    expect(preview.totalUnits).toBe(10);
    expect(preview.totalValueMinor).toBe('1250');
    expect(preview.lines[0]).toMatchObject({ expectedUnits: 12, countedUnits: 10, varianceUnits: -2, unitsPerPack: 10, unitCostMinor: 125, printedMrpMinor: 2500 });
    expect(db.pharmacyOpeningSession.create).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyManufacturingBatch.create).not.toHaveBeenCalled();
    expect(db.packLevel.findMany.mock.calls[0]?.[0].where.organizationId).toBe(scope.organizationId);
  });
  it.each([
    'SRC-1,00123,,2099-06,25,1.25,10,10,',
    'SRC-1,00123,B1,,25,1.25,10,10,',
    'SRC-1,00123,B1,2099-06,,1.25,10,10,',
    'SRC-1,00123,B1,2099-06,25,1.255,10,10,',
    'SRC-1,00123,B1,2099-06,25,1.25,10,,',
    'SRC-1,00123,B1,2099-06,25,1.25,10,1.5,',
    'SRC-1,00123,B1,2099-06,25,-1,10,10,',
    'SRC-1,00123,B1,2000-06,25,1,10,10,',
    'SRC-1,00123,B1,2099-06,25,1.25,12,10,',
    'SRC-1,00123,B1,2099-06,25,100000,100000,100000,',
  ])('blocks missing, fractional, overflowing, unexplained or expired evidence: %s', async (row) => {
    expect((await previewOwnerImport(scoped(), scope, input(row))).canCommit).toBe(false);
  });
  it('preserves explicit zero counts and costs', async () => {
    const preview = await previewOwnerImport(scoped(), scope, input('SRC-1,00123,B1,2099-06,0,0,0,0,'));
    expect(preview.canCommit).toBe(true);
    expect(preview.lines[0]).toMatchObject({ countedUnits: 0, expectedUnits: 0, unitCostMinor: 0, printedMrpMinor: 0 });
  });
  it.each(['2.70', '10.50'])('warns about cost %s without blocking legitimate historical stock', async (cost) => {
    const preview = await previewOwnerImport(scoped(), scope, input(`SRC-1,00123,B1,2099-06,27,${cost},10,10,`));
    expect(preview.canCommit).toBe(true);
    expect(preview.lines[0]!.errors).toEqual([]);
    expect(preview.lines[0]!.warnings.join(' ')).toContain('Cost per tablet/unit');
    expect(preview.totalUnits).toBe(10);
    expect(preview.totalValueMinor).toBe(cost === '2.70' ? '2700' : '10500');
  });
  it('compares cost and pack MRP exactly without rounding a fractional unit MRP', async () => {
    const preview = await previewOwnerImport(scoped(), scope, input('SRC-1,00123,B1,2099-06,27.01,2.70,10,10,'));
    expect(preview.canCommit).toBe(true);
    expect(preview.lines[0]!.warnings).toEqual([]);
  });
  it('excludes rejected rows from dry-run units and valuation', async () => {
    const value = input('SRC-1,00123,B1,2099-06,25,1.25,10,10,');
    value.content = Buffer.from(`${Buffer.from(value.content, 'base64').toString()}\nSRC-2,unknown,B2,2099-06,25,1.25,20,20,`).toString('base64');
    db.packLevel.findMany.mockResolvedValueOnce(await db.packLevel.findMany()).mockResolvedValueOnce([]);
    const preview = await previewOwnerImport(scoped(), scope, value);
    expect(preview.canCommit).toBe(false);
    expect(preview.lines[1]!.errors).not.toHaveLength(0);
    expect(preview.totalUnits).toBe(10);
    expect(preview.totalValueMinor).toBe('1250');
  });
  it('requires distinct mapped columns and rejects columns outside the upload', async () => {
    await expect(previewOwnerImport(scoped(), scope, { ...input(), mapping: { ...mapping, counted: mapping.expected } })).rejects.toThrow('different column');
    await expect(previewOwnerImport(scoped(), scope, { ...input(), mapping: { ...mapping, counted: 39 } })).rejects.toThrow('different column');
  });
  it('rejects foreign branch/location and missing or ambiguous pack matches', async () => {
    db.pharmacyStockLocation.findFirst.mockResolvedValueOnce(null);
    await expect(previewOwnerImport(scoped(), scope, input())).rejects.toThrow('active branch');
    db.packLevel.findMany.mockResolvedValueOnce([]);
    expect((await previewOwnerImport(scoped(), scope, input())).canCommit).toBe(false);
  });
  it('blocks a source reference already used for the same batch by another branch opening import', async () => {
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({ id: 'batch', state: 'ACTIVE', expiryPrecision: 'MONTH', expiresAt: new Date('2099-06-30T00:00:00Z') });
    db.pharmacyInventoryLot.findFirst.mockResolvedValueOnce({ id: 'lot_branch_a' });
    const preview = await previewOwnerImport(scoped(), scope, input());
    expect(preview.canCommit).toBe(false);
    expect(preview.lines[0]!.errors.join(' ')).toMatch(/source reference was already used/);
    expect(db.pharmacyInventoryLot.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: scope.organizationId, supplierName: 'OPENING', supplierInvoiceRef: 'SRC-1', manufacturingBatchId: 'batch' },
    }));
  });
  it('blocks duplicate source references and lot rows', async () => {
    const value = input();
    value.content = Buffer.from(Buffer.from(value.content, 'base64').toString() + '\nSRC-1,00123,B1,2099-06,25,1.25,12,10,Explained').toString('base64');
    const preview = await previewOwnerImport(scoped(), scope, value);
    expect(preview.canCommit).toBe(false);
    expect(preview.lines[1]!.errors.join(' ')).toMatch(/unique.*Duplicate/);
  });
  it('blocks a conflicting or recalled batch', async () => {
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValueOnce({ id: 'batch', state: 'RECALLED', expiryPrecision: 'MONTH', expiresAt: new Date('2099-06-30T19:00:00Z') } as never);
    expect((await previewOwnerImport(scoped(), scope, input())).lines[0]!.errors.join(' ')).toContain('blocked');
  });
  it('refuses to import a previously recorded medicine/batch/pack even from changed bytes', async () => {
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValueOnce({ id: 'batch', state: 'ACTIVE', expiryPrecision: 'MONTH', expiresAt: new Date('2099-06-30T19:00:00Z') } as never);
    db.pharmacyInventoryLot.findMany.mockResolvedValueOnce([{ balances: [{ onHandUnits: 7 }] }] as never);
    const preview = await previewOwnerImport(scoped(), scope, input());
    expect(preview.canCommit).toBe(false);
    expect(preview.lines[0]).toMatchObject({ currentUnits: 7, proposedUnits: 17 });
    expect(preview.lines[0]!.errors.join(' ')).toContain('cannot be imported twice');
  });
  it('rejects adding opening stock to an operating branch', async () => {
    db.pharmacyStockMovement.count.mockResolvedValue(1);
    expect((await previewOwnerImport(scoped(), scope, input())).canCommit).toBe(false);
  });
  it('requires cold-chain storage for a cold-chain medicine', async () => {
    const packs = await db.packLevel.findMany();
    packs[0]!.presentation.medicine.coldChain = true;
    const preview = await previewOwnerImport(scoped(), scope, input());
    expect(preview.canCommit).toBe(false);
    expect(preview.lines[0]!.errors.join(' ')).toContain('cold-chain');
  });
  it('rejects an ambiguous pack hierarchy instead of guessing a conversion', async () => {
    const packs = await db.packLevel.findMany();
    const levels = packs[0]!.presentation.packLevels;
    levels.push({ ...levels[0]!, id: 'unit-a', parentPackLevelId: 'pack', unitsPerParent: 1 });
    levels.push({ ...levels[0]!, id: 'unit-b', parentPackLevelId: 'pack', unitsPerParent: 1 });
    const preview = await previewOwnerImport(scoped(), scope, input());
    expect(preview.canCommit).toBe(false);
    expect(preview.lines[0]!.unitsPerPack).toBeNull();
  });
  it.each([
    { label: 'expired', effectiveFrom: new Date('2020-01-01'), effectiveTo: new Date('2021-01-01') },
    { label: 'future', effectiveFrom: new Date('2099-01-01'), effectiveTo: null },
  ])('matches a current flat pack when its child is $label', async ({ effectiveFrom, effectiveTo }) => {
    const packs = await db.packLevel.findMany();
    const levels = packs[0]!.presentation.packLevels;
    levels.push({ ...levels[0]!, id: 'inactive-child', parentPackLevelId: 'pack', unitsPerParent: 2, effectiveFrom, effectiveTo });

    const preview = await previewOwnerImport(scoped(), scope, input());

    expect(preview.canCommit).toBe(true);
    expect(preview.lines[0]).toMatchObject({ packLevelId: 'pack', unitsPerPack: 10, errors: [] });
  });
  it.each([
    { packId: 'pack', unitsPerPack: 30 },
    { packId: 'strip', unitsPerPack: 10 },
  ])('matches current nested pack $packId using only effective descendants', async ({ packId, unitsPerPack }) => {
    const packs = await db.packLevel.findMany();
    const pack = packs[0]!;
    const levels = pack.presentation.packLevels;
    levels[0]!.level = 'BOX';
    levels[0]!.unitsPerParent = 3;
    levels.push({ ...levels[0]!, id: 'strip', level: 'STRIP', parentPackLevelId: 'pack', unitsPerParent: 10 });
    levels.push({ ...levels[1]!, id: 'expired-strip', effectiveTo: new Date('2021-01-01') });
    levels.push({ ...levels[1]!, id: 'future-strip', effectiveFrom: new Date('2099-01-01') });
    levels.push({ ...levels[1]!, id: 'expired-unit', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 2, effectiveTo: new Date('2021-01-01') });
    levels.push({ ...levels[1]!, id: 'future-unit', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 2, effectiveFrom: new Date('2099-01-01') });
    pack.id = packId;

    const preview = await previewOwnerImport(scoped(), scope, input(`SRC-1,${packId},B1,2099-06,25.00,1.25,12,10,Two damaged units excluded`));

    expect(preview.canCommit).toBe(true);
    expect(preview.lines[0]).toMatchObject({ packLevelId: packId, unitsPerPack, errors: [] });
  });
  it('binds previews to mapping and destination and refuses a stale review before writes', async () => {
    const preview = await previewOwnerImport(scoped(), scope, input());
    await expect(commitOwnerImport(scoped(), scope, { ...input(), stockLocationId: 'another-location', previewHash: preview.previewHash })).rejects.toThrow('changed');
    expect(db.pharmacyOpeningSession.create).not.toHaveBeenCalled();
  });
  it('DEV-825: locks medicines, then the branch lots, before the locked preview re-enters them', async () => {
    const preview = await previewOwnerImport(scoped(), scope, input());
    db.$queryRaw.mockClear();
    await expect(commitOwnerImport(scoped(), scope, { ...input(), stockLocationId: 'another-location', previewHash: preview.previewHash })).rejects.toThrow('changed');
    const stock = db.$queryRaw.mock.calls
      .map(([sql]) => sql as { strings?: string[]; values: unknown[] })
      .map((sql) => ({ text: sql.strings?.join('') ?? '', values: sql.values }))
      .filter(({ text }) => text.includes('stock_lock:'));
    // Draft medicine, then every lot (FOR UPDATE fences first movements), then the
    // locked preview's own medicine lock, which only re-enters the one already held.
    expect(stock.map(({ text }) => /stock_lock:(\w+)/.exec(text)![1])).toEqual(['medicine', 'lot', 'medicine']);
    expect(stock[0]!.text).toContain('FOR SHARE');
    expect(stock[1]!.text).toContain('FOR UPDATE');
    expect(stock[1]!.text).not.toContain('NO KEY');
    expect(stock[0]!.values).toEqual(expect.arrayContaining([['medicine']]));
    expect(stock[2]!.values).toEqual(expect.arrayContaining(['medicine']));
  });
  it('pins replay identity to the tenant, branch and original bytes', () => {
    const bytes = Buffer.from('source');
    expect(openingImportIdentity('org_a', 'branch_a', bytes)).toEqual(openingImportIdentity('org_a', 'branch_a', bytes));
    expect(openingImportIdentity('org_a', 'branch_a', bytes).sessionId).not.toBe(openingImportIdentity('org_b', 'branch_a', bytes).sessionId);
    expect(openingImportIdentity('org_a', 'branch_a', bytes).sessionId).not.toBe(openingImportIdentity('org_a', 'branch_b', bytes).sessionId);
  });
  it('returns the committed receipt on replay, even after stock has moved', async () => {
    db.pharmacyOpeningTotal.findFirst.mockResolvedValueOnce({ totalUnits: 10, totalValueMinor: BigInt(1250) } as never);
    expect(await commitOwnerImport(scoped(), scope, { ...input(), previewHash: 'a'.repeat(64) })).toMatchObject({ replayed: true, totalUnits: 10, totalValueMinor: '1250' });
    expect(db.pharmacyStockMovement.count).not.toHaveBeenCalled();
    expect(db.pharmacyOpeningSession.create).not.toHaveBeenCalled();
  });
});

it('matches the reported 58 valid units and PKR609 valuation while excluding 20 rejected units',async()=>{
  const packs=await db.packLevel.findMany();
  db.packLevel.findMany.mockResolvedValueOnce(packs).mockResolvedValueOnce(packs).mockResolvedValueOnce([]);
  const value=input('VALID-1,00123,B1,2099-06,27,10.50,30,30,');
  value.content=Buffer.from(Buffer.from(value.content,'base64').toString()+'\nVALID-2,00123,B2,2099-06,27,10.50,28,28,\nREJECT,unknown,B3,2099-06,27,10.50,20,20,').toString('base64');
  const preview=await previewOwnerImport(scoped(),scope,value);
  expect(preview.lines).toHaveLength(3);expect(preview.lines[2]!.errors.length).toBeGreaterThan(0);
  expect(preview.lines.slice(0,2).every(line=>line.errors.length===0&&line.warnings.length===1)).toBe(true);
  expect(preview.totalUnits).toBe(58);expect(preview.totalValueMinor).toBe('60900');expect(preview.canCommit).toBe(false);
});
it('warns on positive cost with zero MRP while retaining zero-count and zero-cost imports',async()=>{
  const preview=await previewOwnerImport(scoped(),scope,input('SRC-1,00123,B1,2099-06,0,1.00,0,0,'));
  expect(preview.canCommit).toBe(true);expect(preview.lines[0]!.warnings).toHaveLength(1);expect(preview.totalValueMinor).toBe('0');
});
