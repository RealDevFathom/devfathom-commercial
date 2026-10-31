import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  listPurchaseReturns,
  listSupplierCredits,
  purchasingWorkspace,
  type PurchasingReadBounds,
} from './purchasing-console';

it('projects owner solo approval eligibility for each branch and the organization separately', async () => {
  const db = {
    pharmacyBranch: { findMany: vi.fn().mockResolvedValue([{ id: 'solo' }, { id: 'staffed' }]) },
    pharmacyStockLocation: { findMany: vi.fn().mockResolvedValue([]) },
    medicine: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacySupplier: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      // The workspace decides procurement from the listed row, without a per-person lookup.
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'owner',
          name: 'Owner',
          email: 'owner@test.invalid',
          status: 'ACTIVE',
          role: 'ADMIN',
          organizationRole: {
            key: 'owner',
            isSystem: true,
            permissions: [{ capability: '*', effect: 'ALLOW' }],
          },
          permissionOverrides: [],
        },
      ]),
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        role: 'ADMIN',
        organizationRole: {
          key: 'owner',
          isSystem: true,
          permissions: [{ capability: '*', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
      count: vi
        .fn()
        .mockImplementation(({ where }) =>
          where.OR?.[0]?.pharmacyBranchAssignments?.some?.branchId === 'solo' ? 0 : 1
        ),
    },
  };
  const workspace = await purchasingWorkspace(db as unknown as ScopedDb, {
    organizationId: 'org',
    actorId: 'owner',
  });
  expect(workspace.procurementApprovers).toEqual([
    {
      id: 'owner',
      name: 'Owner',
      email: 'owner@test.invalid',
      soloOrganizationWide: false,
      soloBranchIds: ['solo'],
    },
  ]);
});

const scope = { organizationId: 'org_a', branchId: 'branch_a' };
const from = new Date('2026-09-01T00:00:00.000Z');
const to = new Date('2026-09-03T23:59:59.999Z');
const row = (id: string) => ({
  ...scope,
  id,
  createdAt: from,
  receivedAt: from,
  lines: [],
  debitNotes: [],
  allocations: [],
});
function database(rows: ReturnType<typeof row>[] = []) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return {
    findMany,
    db: {
      pharmacyPurchaseReturn: { findMany },
      pharmacySupplierCredit: { findMany },
    } as unknown as ScopedDb,
  };
}

describe.each([
  ['returns', listPurchaseReturns, 'createdAt'],
  ['credits', listSupplierCredits, 'receivedAt'],
] as const)('bounded live %s reader', (_label, read, dateBasis) => {
  it('pins tenant, branch and inclusive dates before limiting a deterministic source query', async () => {
    const { db, findMany } = database([row('b'), row('a')]);
    const before = Date.now();
    const result = await read(db, scope, { from, to, page: { limit: 1 } });
    expect(findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { ...scope, [dateBasis]: { gte: from, lte: to } },
        orderBy: [{ [dateBasis]: 'desc' }, { id: 'desc' }],
        take: 2,
      })
    );
    expect(result).toMatchObject({
      rows: [{ id: 'b' }],
      coverage: 'partial',
      truncated: true,
      nextCursor: { at: from, id: 'b' },
      cap: { limit: 1, max: 100 },
      bounds: { from, to },
      dateBasis,
      snapshot: 'live',
    });
    expect(result.observedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.observedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(result.rows).toHaveLength(1);
  });

  it('uses a date/id keyset with the same scope/range, without looking up the cursor row', async () => {
    const { db, findMany } = database([row('a')]);
    const after = { at: from, id: 'b' };
    const result = await read(db, scope, { from, to, page: { limit: 1, after } });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ...scope,
          [dateBasis]: { gte: from, lte: to },
          OR: [{ [dateBasis]: { lt: from } }, { [dateBasis]: from, id: { lt: 'b' } }],
        },
        take: 2,
      })
    );
    expect(result).toMatchObject({
      rows: [{ id: 'a' }],
      coverage: 'partial',
      truncated: false,
      nextCursor: null,
    });
  });

  it.each([0, 1])('reports exhausted first-page coverage for %i records', async (count) => {
    const { db } = database(count ? [row('a')] : []);
    const result = await read(db, scope, { page: { limit: 1 } });
    expect(result).toMatchObject({
      coverage: 'complete',
      truncated: false,
      nextCursor: null,
      bounds: { from: null, to: null },
      snapshot: 'live',
    });
    expect(result.rows).toHaveLength(count);
  });

  it('does not call an empty later page complete', async () => {
    const { db } = database();
    expect(
      await read(db, scope, { page: { after: { at: from, id: 'foreign-cursor' } } })
    ).toMatchObject({
      rows: [],
      coverage: 'partial',
      truncated: false,
      nextCursor: null,
      cap: { limit: 50, max: 100 },
    });
  });

  it('preserves legacy unpaginated arrays, with optional one-sided date bounds', async () => {
    const { db, findMany } = database([row('b'), row('a')]);
    const legacy = await read(db, scope);
    expect(Array.isArray(legacy)).toBe(true);
    expect(legacy.map((item) => item.id)).toEqual(['b', 'a']);
    expect(findMany.mock.calls[0]![0]).not.toHaveProperty('take');
    expect(Array.isArray(await read(db, scope, { from }))).toBe(true);
    expect(findMany.mock.lastCall![0].where[dateBasis]).toEqual({ gte: from, lte: undefined });
    await read(db, scope, { to });
    expect(findMany.mock.lastCall![0].where[dateBasis]).toEqual({ gte: undefined, lte: to });
  });

  it.each([
    { from: to, to: from },
    { from: new Date('invalid') },
    { page: { limit: 0 } },
    { page: { limit: 101 } },
    { page: { limit: 1.5 } },
    { page: { after: { at: from, id: '' } } },
  ])('rejects invalid bounds before reading: %j', async (options) => {
    const { db, findMany } = database();
    await expect(read(db, scope, options as PurchasingReadBounds)).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
  });
});

it('retains the legacy at clock for window preparation without claiming historical balances', async () => {
  const { db, findMany } = database();
  findMany.mockResolvedValue([{ ...row('a'), lines: [{ returnWindowEndsAt: to }] }]);
  const legacy = await listPurchaseReturns(db, scope, { at: from });
  expect(legacy[0]!.lines[0]!.daysToWindowEnd).toBe(2);
  const page = await listPurchaseReturns(db, scope, { at: from, page: {} });
  expect(page.snapshot).toBe('live');
  expect(page.observedAt.getTime()).toBeGreaterThan(to.getTime());
});
