import { describe, expect, it, vi } from 'vitest';
import {
  confirmPriceChanges,
  DRAP_PRICE_INFORMATION_ONLY,
  currentPackPrice,
  packUnits,
  priceVariance,
  priceIntelligence,
  priceOverrides,
  resolveNoticePack,
  setManualPackPrice,
} from './pricing';
import { confirmPriceChange, FileDrapNoticeSource, ingestDrapNotice } from './drap-monitoring';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
const scope = { organizationId: 'org-a', actorId: 'actor' };
const nodes = [
  {
    id: 'box',
    parentPackLevelId: null,
    unitsPerParent: 1,
    level: 'BOX',
    presentationId: 'presentation',
  },
  {
    id: 'strip',
    parentPackLevelId: 'box',
    unitsPerParent: 3,
    level: 'STRIP',
    presentationId: 'presentation',
  },
  {
    id: 'unit',
    parentPackLevelId: 'strip',
    unitsPerParent: 10,
    level: 'UNIT',
    presentationId: 'presentation',
  },
];
function fake() {
  const proposal = {
    id: 'proposal',
    medicineId: 'medicine',
    packLevelId: 'box',
    status: 'PROPOSED',
    effectiveDate: new Date('2027-01-01'),
    notifiedPriceMinor: 30000,
    ingest: {
      matchStatus: 'MATCHED',
      priceNotice: { presentation: 'Tablet 500 mg', packLevel: 'BOX' },
    },
  };
  const db = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    $queryRaw: vi.fn(),
    pharmacyPriceChangeProposal: {
      findFirst: vi.fn(async () => proposal),
      update: vi.fn(async ({ data }) => ({ ...proposal, ...data })),
    },
    packLevel: { findMany: vi.fn(async ({ where }) => (where.level ? [nodes[0]] : nodes)) },
    pharmacyPackPrice: {
      findFirst: vi.fn(async ({ where }) =>
        where.proposalId ? null : { mrpMinor: 20000, sellingPriceMinor: null }
      ),
      create: vi.fn(async ({ data }) => ({ id: 'price', ...data })),
    },
    auditLog: { create: vi.fn() },
  };
  return { db, scoped: db as unknown as ScopedDb, proposal };
}
describe('WHA-1606 pack pricing', () => {
  it('derives BOX/STRIP/UNIT at the same pack level', () => {
    expect(packUnits(nodes, 'box')).toBe(30);
    expect(packUnits(nodes, 'strip')).toBe(10);
    expect(packUnits(nodes, 'unit')).toBe(1);
    expect(priceVariance(33000, 30000, 30)).toEqual({
      amountMinor: 3000,
      percent: 10,
      sellingUnitMinor: 1100,
      mrpUnitMinor: 1000,
    });
  });
  it('preserves missing selling policies and avoids zero-MRP division', () => {
    expect(priceVariance(null, 30000, 30)).toMatchObject({
      amountMinor: null,
      percent: null,
      sellingUnitMinor: null,
    });
    expect(priceVariance(0, 0, 1)).toMatchObject({ amountMinor: 0, percent: null });
    expect(priceVariance(0, 100, 1)).toMatchObject({ amountMinor: -100, percent: -100 });
    expect(priceVariance(100, null, 1)).toMatchObject({ amountMinor: null, mrpUnitMinor: null });
  });
  it('rejects missing, ambiguous and cyclic conversions', () => {
    expect(() => packUnits(nodes.slice(0, 2), 'box')).toThrow();
    expect(() => packUnits([...nodes, { ...nodes[1], id: 'other' }], 'box')).toThrow();
    expect(() =>
      packUnits([{ ...nodes[0], parentPackLevelId: 'strip' }, nodes[1]], 'box')
    ).toThrow();
  });
  it('parser carries exact presentation/pack and rejects invalid labels', async () => {
    const input = {
      kind: 'PRICE',
      sourceReference: 'SRO',
      drapRegistrationNumber: 'reg',
      presentation: 'گولی 500 mg',
      packLevel: 'BOX',
      notifiedPriceMinor: 100,
      effectiveDate: '2027-01-01',
    };
    expect((await new FileDrapNoticeSource(JSON.stringify([input])).read())[0]).toMatchObject({
      presentation: input.presentation,
      packLevel: 'BOX',
    });
    await expect(
      new FileDrapNoticeSource(JSON.stringify([{ ...input, packLevel: 'guess' }])).read()
    ).rejects.toThrow();
  });
  it('missing and ambiguous named pack identity fail closed', async () => {
    const { db, scoped } = fake();
    expect(
      await resolveNoticePack(scoped, 'org-a', 'medicine', undefined, 'BOX', new Date())
    ).toBeNull();
    db.packLevel.findMany.mockResolvedValueOnce([nodes[0], nodes[0]]);
    expect(
      await resolveNoticePack(scoped, 'org-a', 'medicine', 'Tablet', 'BOX', new Date())
    ).toBeNull();
  });
  it.each(['PROPOSED', 'CONFIRMED'])(
    'DEV-693: refuses to confirm a %s DRAP proposal and writes no price, status or audit',
    async (status) => {
      for (const confirm of [
        (scoped: ScopedDb) => confirmPriceChange(scoped, scope, 'proposal'),
        (scoped: ScopedDb) => confirmPriceChanges(scoped, scope, ['proposal']),
      ]) {
        const { db, scoped, proposal } = fake();
        proposal.status = status;
        await expect(confirm(scoped)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: DRAP_PRICE_INFORMATION_ONLY,
        });
        expect(db.pharmacyPriceChangeProposal.findFirst).toHaveBeenCalledWith({
          where: { organizationId: 'org-a', id: 'proposal' },
          select: { id: true, ingestId: true },
        });
        expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
        expect(db.pharmacyPriceChangeProposal.update).not.toHaveBeenCalled();
        expect(db.auditLog.create).not.toHaveBeenCalled();
      }
    }
  );
  it('reports a missing proposal as not found, still without writes', async () => {
    const { db, scoped } = fake();
    db.pharmacyPriceChangeProposal.findFirst.mockResolvedValueOnce(null as never);
    await expect(confirmPriceChanges(scoped, scope, ['missing'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
  });
  it('duplicate selection rejected before any read', async () => {
    const { db, scoped } = fake();
    await expect(confirmPriceChanges(scoped, scope, ['a', 'a'])).rejects.toThrow();
    expect(db.pharmacyPriceChangeProposal.findFirst).not.toHaveBeenCalled();
  });
  it('current selection explicitly excludes future effective dates', async () => {
    const { db, scoped } = fake();
    const at = new Date('2026-09-29');
    await currentPackPrice(scoped, 'org-a', 'box', at);
    expect(db.pharmacyPackPrice.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        packLevelId: 'box',
        branchId: null,
        effectiveFrom: { lte: at },
      },
      orderBy: { effectiveFrom: 'desc' },
    });
  });
  it('unmatched ingest retains full presentation payload', async () => {
    const create = vi.fn(async ({ data }) => data);
    const db = {
      pharmacyDrapIngest: { findFirst: vi.fn(async () => null), create },
      medicine: { findMany: vi.fn(async () => []) },
    } as unknown as ScopedDb;
    await ingestDrapNotice(db, scope, 'FILE', {
      kind: 'PRICE',
      sourceReference: 'SRO',
      drapRegistrationNumber: 'unknown',
      presentation: 'Tablet',
      packLevel: 'BOX',
      notifiedPriceMinor: 100,
      effectiveDate: new Date('2027-01-01'),
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        matchStatus: 'NO_MATCH',
        priceNotice: expect.objectContaining({ presentation: 'Tablet', packLevel: 'BOX' }),
      }),
    });
  });
});

describe('manual pack price', () => {
  const input = {
    packLevelId: 'box',
    mrpMinor: 10000,
    sellingPriceMinor: 10001 as number | null,
    effectiveFrom: new Date('2027-01-01'),
  };
  it('rejects a selling price above the declared MRP before any write', async () => {
    const { db, scoped } = fake();
    await expect(setManualPackPrice(scoped, scope, input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Selling price cannot exceed MRP',
    });
    await expect(
      setManualPackPrice(scoped, scope, { ...input, branchId: 'branch' })
    ).rejects.toThrow('Selling price cannot exceed MRP');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.pharmacyPackPrice.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
  it.each([10000, 9999, 0, null])('accepts selling price %s at or below MRP', async (selling) => {
    const { db, scoped } = fake();
    Object.assign(db, {
      packLevel: {
        findFirst: vi.fn(async () => ({
          id: 'box',
          presentationId: 'presentation',
          presentation: { organizationId: scope.organizationId },
        })),
      },
    });
    await setManualPackPrice(scoped, scope, { ...input, sellingPriceMinor: selling });
    expect(db.pharmacyPackPrice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ mrpMinor: 10000, sellingPriceMinor: selling }),
    });
    expect(db.auditLog.create).toHaveBeenCalledOnce();
  });
});

describe('current pack report', () => {
  it('selects current organization policies independently of notices, excludes expired packs and future/branch policies', async () => {
    const now = new Date();
    const pack = (id: string, effectiveTo: Date | null = null) => ({
      id,
      presentationId: 'presentation',
      parentPackLevelId: null,
      level: 'UNIT',
      unitsPerParent: 1,
      effectiveTo,
      effectiveFrom: new Date('2020-01-01'),
      presentation: {
        medicineId: 'medicine',
        presentation: 'Tablet',
        medicine: { productName: 'Manual medicine', aliases: [{ value: 'گولی' }] },
      },
    });
    const policy = (
      id: string,
      packLevelId: string,
      date: string,
      branchId: string | null = null
    ) => ({
      id,
      packLevelId,
      branchId,
      mrpMinor: 100,
      sellingPriceMinor: 120,
      source: 'manual',
      effectiveFrom: new Date(date),
    });
    const policies = [
      policy('future', 'manual', '2099-01-01'),
      policy('branch', 'manual', '2026-01-01', 'branch'),
      policy('current', 'manual', '2025-01-01'),
      policy('old', 'manual', '2024-01-01'),
      policy('expired-price', 'expired', '2024-01-01'),
    ];
    const packs = [pack('manual'), pack('expired', new Date('2025-01-01'))];
    const db = {
      pharmacyDrapIngest: { findMany: vi.fn(async () => []) },
      packLevel: {
        findMany: vi.fn(async ({ where }) => {
          expect(where).toMatchObject({
            organizationId: scope.organizationId,
            effectiveFrom: { lte: expect.any(Date) },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: expect.any(Date) } }],
          });
          return packs.filter((p) => !p.effectiveTo || p.effectiveTo > now);
        }),
      },
      pharmacyPackPrice: {
        findMany: vi.fn(async ({ where }) => {
          expect(where).toEqual({
            organizationId: scope.organizationId,
            branchId: null,
            effectiveFrom: { lte: expect.any(Date) },
          });
          return policies.filter(
            (p) => p.branchId === where.branchId && p.effectiveFrom <= where.effectiveFrom.lte
          );
        }),
      },
    };
    const result = await priceIntelligence(db as unknown as ScopedDb, scope);
    expect(result.rows).toEqual([]);
    expect(result.packRows).toHaveLength(1);
    expect(result.packRows[0]).toMatchObject({
      id: 'manual',
      source: 'manual',
      effectiveDate: new Date('2025-01-01'),
      confirmedMrpMinor: 100,
      amountMinor: 20,
      percent: 20,
      units: 1,
    });
  });
  it('preserves branch values and flags versions against latest organization policy', async () => {
    const db = {
      pharmacyPackPrice: {
        findMany: vi.fn(async () => [
          {
            id: 'override',
            packLevelId: 'box',
            branchId: 'branch',
            reviewedOrgPriceId: 'old',
            mrpMinor: 150,
            sellingPriceMinor: 140,
          },
        ]),
        findFirst: vi.fn(async () => ({ id: 'new-scheduled' })),
      },
      packLevel: {
        findFirst: vi.fn(async () => ({
          level: 'BOX',
          presentation: { presentation: 'Tablet', medicine: { productName: 'Medicine' } },
        })),
      },
      pharmacyBranch: { findFirst: vi.fn(async () => ({ name: 'Main branch' })) },
    };
    const result = await priceOverrides(db as unknown as ScopedDb, scope);
    expect(db.pharmacyPackPrice.findMany).toHaveBeenCalledWith({
      where: { organizationId: scope.organizationId, branchId: { not: null }, isOverride: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    expect(result[0]).toMatchObject({
      mrpMinor: 150,
      sellingPriceMinor: 140,
      needsReview: true,
      branchName: 'Main branch',
      medicine: 'Medicine',
    });
  });
});
