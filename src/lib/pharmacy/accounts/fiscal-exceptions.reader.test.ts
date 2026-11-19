import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as abac from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { verticalForModuleKey } from '@/lib/module-catalog';
import { readFiscalExceptions, type FiscalExceptionContext } from './fiscal-exceptions.reader';

const filters = { branchId: 'branch-1', from: '2026-07-01', to: '2026-10-01' };
const document = {
  id: 'doc-1', localReference: 'LOCAL-1', kind: 'INVOICE', status: 'QUEUED',
  integratorMode: 'SANDBOX', attempts: 1, maxAttempts: 3,
  nextAttemptAt: new Date('2026-07-02T00:00:00Z'),
  createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'),
};

function context(db?: ScopedDb, organizationId = 'org-1', actorId = 'owner-1'): FiscalExceptionContext {
  return {
    session: { user: { id: actorId, organizationId, role: 'ADMIN', status: 'ACTIVE' } },
    organization: { id: organizationId, status: 'ACTIVE', vertical: 'PHARMACY' },
    entitlements: { organizationId, enabledModules: ['pharmacy-reports'] },
    requestMeta: { ip: null, userAgent: null },
    db,
  } as unknown as FiscalExceptionContext;
}

function fakeDb() {
  // No writable delegates are exposed: the reader has only these four read operations.
  return {
    organization: { findFirst: vi.fn().mockResolvedValue({ id: 'org-1' }) },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-1', name: 'Main' }) },
    pharmacyFiscalConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyFiscalDocument: { findMany: vi.fn().mockResolvedValue([document]) },
  };
}

describe('fiscal exception reader access and query isolation', () => {
  let db: ReturnType<typeof fakeDb>;
  let ctx: FiscalExceptionContext;
  beforeEach(() => {
    db = fakeDb();
    ctx = context(db as unknown as ScopedDb);
    vi.spyOn(abac, 'can').mockResolvedValue(true);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
  });
  afterEach(() => vi.restoreAllMocks());

  function expectNoEvidenceRead() {
    expect(db.pharmacyFiscalConfiguration.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyFiscalDocument.findMany).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  }

  it.each(['missing-session', 'inactive-user', 'revoked', 'password-change', 'non-admin',
    'foreign-session', 'foreign-entitlements', 'inactive-org', 'wrong-vertical', 'unlicensed'])
  ('denies %s before reading fiscal evidence', async (variant) => {
    const user = ctx.session!.user;
    if (variant === 'missing-session') ctx.session = null;
    if (variant === 'inactive-user') user.status = 'INACTIVE';
    if (variant === 'revoked') user.sessionRevoked = true;
    if (variant === 'password-change') user.mustChangePassword = true;
    if (variant === 'non-admin') user.role = 'EMPLOYEE';
    if (variant === 'foreign-session') user.organizationId = 'foreign';
    if (variant === 'foreign-entitlements') ctx.entitlements.organizationId = 'foreign';
    if (variant === 'inactive-org') ctx.organization!.status = 'SUSPENDED';
    if (variant === 'wrong-vertical') {
      ctx.organization!.vertical = verticalForModuleKey('restaurant-core')!;
    }
    if (variant === 'unlicensed') ctx.entitlements.enabledModules = [];
    await expect(readFiscalExceptions(ctx, filters)).rejects.toMatchObject({
      code: variant === 'missing-session' ? 'UNAUTHORIZED' : 'FORBIDDEN',
    });
    expect(db.organization.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
    expectNoEvidenceRead();
  });

  it.each(['reports:operational', 'reports:financial'] as const)
  ('requires explicit %s permission before scope or fiscal reads', async (capability) => {
    vi.mocked(abac.can).mockImplementation(async (_subject, action) => action !== capability);
    await expect(readFiscalExceptions(ctx, filters)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.organization.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
    expectNoEvidenceRead();
  });

  it('checks both capabilities against the supplied tenant-scoped database', async () => {
    await readFiscalExceptions(ctx, filters);
    for (const action of ['reports:operational', 'reports:financial']) {
      expect(abac.can).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner-1' }), action,
        undefined, expect.objectContaining({ db: ctx.db }));
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a now-inactive organization before branch and fiscal reads', async () => {
    db.organization.findFirst.mockResolvedValue(null);
    await expect(readFiscalExceptions(ctx, filters)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.organization.findFirst).toHaveBeenCalledWith({
      where: { id: 'org-1', status: 'ACTIVE', vertical: 'PHARMACY' }, select: { id: true },
    });
    expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
    expectNoEvidenceRead();
  });

  it.each(['foreign-branch', 'inactive-branch', 'missing-branch'])
  ('refuses %s before fiscal reads', async (branchId) => {
    db.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(readFiscalExceptions(ctx, { ...filters, branchId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', id: branchId, active: true }, select: { id: true, name: true, businessDayEndsAtHour: true },
    });
    expectNoEvidenceRead();
  });

  it.each([{ to: '2026-10-02' }, { page: 20 }, { pageSize: 101 }, { organizationId: 'foreign' }])
  ('refuses expanded envelopes %j before all data reads', async (change) => {
    await expect(readFiscalExceptions(ctx, { ...filters, ...change })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.organization.findFirst).not.toHaveBeenCalled();
    expectNoEvidenceRead();
  });

  it('selects only safe columns with tenant, branch, current state and half-open date predicates', async () => {
    db.pharmacyFiscalDocument.findMany.mockResolvedValue([{ ...document,
      payload: { secret: 'DO_NOT_EXPORT' }, externalQr: 'DO_NOT_EXPORT', lastError: 'DO_NOT_EXPORT',
    }]);
    const result = await readFiscalExceptions(ctx, filters);
    expect(db.pharmacyFiscalDocument.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', branchId: 'branch-1',
        status: { in: ['QUEUED', 'REJECTED', 'DEAD'] },
        createdAt: { gte: new Date('2026-07-01T00:00:00Z'), lt: new Date('2026-10-01T00:00:00Z') },
      },
      select: { id: true, localReference: true, kind: true, integratorMode: true, status: true,
        attempts: true, maxAttempts: true, nextAttemptAt: true, createdAt: true, updatedAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: 0, take: 51,
    });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPORT');
    expect(result.rows[0].nextAttemptAt).toBe('2026-07-02T00:00:00.000Z');
    expect(result.coverage).toBe('UNKNOWN');
  });

  it.each([null, { integratorMode: 'OFF' }, { integratorMode: 'SANDBOX' }])
  ('reports explicit configuration %j without hiding historical document mode', async (config) => {
    db.pharmacyFiscalConfiguration.findFirst.mockResolvedValue(config);
    const result = await readFiscalExceptions(ctx, filters);
    expect(result.configuredMode).toBe(config?.integratorMode ?? 'OFF');
    expect(result.rows[0].integratorMode).toBe('SANDBOX');
  });

  it.each([
    // 19:30 UTC on 31 Oct is 00:30 on 1 Nov in Karachi; 18:59 UTC is still 31 Oct there.
    ['Asia/Karachi', '2026-10-31T19:00:00.000Z', '2026-11-01T19:00:00.000Z', true, false],
    // A UTC organisation (or one with no zone) reads the same UTC midnights as before.
    ['UTC', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', false, false],
    [null, '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', false, false],
  ] as const)('reads the picked days on the organisation clock (%s) (DEV-722)', async (
    timezone, gte, lt, at1930, at1859
  ) => {
    const base = context(db as unknown as ScopedDb);
    const ctx = { ...base, organization: { ...base.organization!, timezone } } as FiscalExceptionContext;
    const result = await readFiscalExceptions(ctx, { ...filters, from: '2026-11-01', to: '2026-11-02' });
    const window = db.pharmacyFiscalDocument.findMany.mock.calls[0]![0].where.createdAt;
    expect(window).toEqual({ gte: new Date(gte), lt: new Date(lt) });
    const inside = (at: string) => new Date(at) >= window.gte && new Date(at) < window.lt;
    expect(inside('2026-10-31T19:30:00Z')).toBe(at1930);
    expect(inside('2026-10-31T18:59:00Z')).toBe(at1859);
    expect(result.window).toEqual({ from: gte, to: lt });
    expect(result.timeZone).toBe(timezone);
    expect(result.filters).toMatchObject({ from: '2026-11-01', to: '2026-11-02' });
  });

  it('uses a lookahead row, bounds offsets, and never asserts complete coverage', async () => {
    db.pharmacyFiscalDocument.findMany.mockResolvedValue([document, { ...document, id: 'doc-2' }]);
    const first = await readFiscalExceptions(ctx, { ...filters, pageSize: 1 });
    expect(first).toMatchObject({ hasMoreAtRead: true, pageCapReached: false, nextPage: 1, coverage: 'UNKNOWN' });
    expect(first.rows).toHaveLength(1);
    const last = await readFiscalExceptions(ctx, { ...filters, page: 19, pageSize: 1 });
    expect(last).toMatchObject({ hasMoreAtRead: true, pageCapReached: true, nextPage: null, coverage: 'UNKNOWN' });
    expect(db.pharmacyFiscalDocument.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 19, take: 2 }));
    db.pharmacyFiscalDocument.findMany.mockResolvedValue([]);
    expect(await readFiscalExceptions(ctx, filters)).toMatchObject({
      rows: [], nextPage: null, coverage: 'UNKNOWN', hasMoreAtRead: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

/** Disposable migrated DB only. No platform scope or RLS bypass is used, including fixture setup. */
const dbUrl = process.env.TEST_DATABASE_URL;
const dbSuite = dbUrl ? describe : describe.skip;
dbSuite('fiscal evidence on PostgreSQL with enforced RLS and real report capabilities', () => {
  const org = `fiscal672_${randomUUID()}`;
  const otherOrg = `${org}_other`;
  const actor = `${org}_owner`;
  const branch = `${org}_branch`;
  const sibling = `${org}_sibling`;
  let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;

  beforeAll(async () => {
    process.env.DATABASE_URL = dbUrl!;
    const scoped = await import('@/lib/tenancy/scoped-db');
    withTenantDb = scoped.withTenantDb;
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole((run, options) => withTenantDb(org, run, options));
    for (const organizationId of [org, otherOrg]) {
      await withTenantDb(organizationId, async (db) => {
        await db.organization.create({ data: {
          id: organizationId, slug: organizationId, legalName: organizationId,
          displayName: organizationId, status: 'ACTIVE', vertical: 'PHARMACY',
        } });
        await db.organizationDepartment.create({ data: { organizationId, key: 'accounts', name: 'Accounts' } });
        const role = await db.organizationRole.create({ data: {
          organizationId, key: 'fiscal672', name: 'Fiscal evidence reader',
          permissions: { create: ['reports:operational', 'reports:financial'].map((capability) => ({
            organizationId, capability, effect: 'ALLOW' as const,
          })) },
        } });
        await db.user.create({ data: {
          id: organizationId === org ? actor : `${actor}_other`, organizationId,
          organizationRoleId: role.id, name: 'Evidence reader', email: `${organizationId}@example.invalid`,
          role: 'ADMIN', status: 'ACTIVE', department: 'accounts', title: 'Reader',
        } });
        for (const branchId of organizationId === org ? [branch, sibling, `${branch}_inactive`] : [`${branch}_foreign`]) {
          await db.pharmacyBranch.create({ data: {
            id: branchId, organizationId, code: branchId, name: branchId,
            addressLine: 'Test', city: 'Test', provinceCode: 'TEST', active: !branchId.endsWith('_inactive'),
          } });
          for (const [index, status, createdAt, mode] of [
            [0, 'QUEUED', '2026-07-01', 'SANDBOX'],
            [1, 'REJECTED', '2026-07-02', 'SANDBOX'],
            [2, 'DEAD', '2026-07-03', 'OFF'],
            [3, 'ACCEPTED', '2026-07-04', 'SANDBOX'],
            [4, 'SUBMITTING', '2026-07-05', 'SANDBOX'],
            [5, 'QUEUED', '2026-10-01', 'SANDBOX'],
            [6, 'QUEUED', '2026-06-30', 'SANDBOX'],
          ] as const) {
            await db.pharmacyFiscalDocument.create({ data: {
              id: `${branchId}_${index}`, organizationId, branchId,
              localReference: `${branchId}_${index}`, kind: 'INVOICE', status, integratorMode: mode,
              attempts: 0, maxAttempts: 3, payload: { secret: 'not exported' }, payloadHash: 'not exported',
              lastError: 'sensitive raw provider error', createdByActorId: actor,
              createdAt: new Date(`${createdAt}T00:00:00Z`), retentionUntil: new Date('2033-01-01T00:00:00Z'),
            } });
          }
        }
      });
    }
  }, 30_000);

  it('reads exactly current exceptions, excludes other branches/dates/states, and performs no writes', async () => {
    await withTenantDb(org, async (db) => {
      await db.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const result = await readFiscalExceptions(context(db, org, actor), { ...filters, branchId: branch });
      expect(result.rows.map((row) => row.id)).toEqual([`${branch}_0`, `${branch}_1`, `${branch}_2`]);
      expect(result.rows.map((row) => row.status)).toEqual(['QUEUED', 'REJECTED', 'DEAD']);
      expect(result.rows.map((row) => row.integratorMode)).toEqual(['SANDBOX', 'SANDBOX', 'OFF']);
      expect(result.configuredMode).toBe('OFF');
      expect(result.coverage).toBe('UNKNOWN');
      expect(JSON.stringify(result)).not.toMatch(/not exported|sensitive raw provider/);
    }, { skipDrain: true });
  });

  it('refuses foreign and inactive branches with real database scope checks', async () => {
    for (const branchId of [`${branch}_foreign`, `${branch}_inactive`]) {
      await expect(withTenantDb(org, (db) => readFiscalExceptions(context(db, org, actor), {
        ...filters, branchId,
      }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('paginates a real selected population without asserting complete coverage', async () => {
    await withTenantDb(org, async (db) => {
      await db.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const first = await readFiscalExceptions(context(db, org, actor), {
        ...filters, branchId: branch, pageSize: 2,
      });
      expect(first.rows.map((row) => row.id)).toEqual([`${branch}_0`, `${branch}_1`]);
      expect(first).toMatchObject({ hasMoreAtRead: true, nextPage: 1, coverage: 'UNKNOWN' });
      const second = await readFiscalExceptions(context(db, org, actor), {
        ...filters, branchId: branch, pageSize: 2, page: 1,
      });
      expect(second.rows.map((row) => row.id)).toEqual([`${branch}_2`]);
      expect(second).toMatchObject({ hasMoreAtRead: false, nextPage: null, coverage: 'UNKNOWN' });
    }, { skipDrain: true });
  });

  it('fiscal table RLS independently rejects tenant and branch predicate forgery', async () => {
    await withTenantDb(org, async (db) => {
      expect(await db.pharmacyFiscalDocument.findMany({
        where: { organizationId: otherOrg }, select: { id: true },
      })).toEqual([]);
      await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branch);
      expect(await db.pharmacyFiscalDocument.findMany({
        where: { organizationId: org, branchId: sibling }, select: { id: true },
      })).toEqual([]);
    });
  });

  it('RLS refuses a foreign tenant context even if supplied as all application anchors', async () => {
    await expect(withTenantDb(org, (db) => readFiscalExceptions(context(db, otherOrg, `${actor}_other`), {
      ...filters, branchId: `${branch}_foreign`,
    }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('database capability denial precedes the fiscal document query', async () => {
    await withTenantDb(org, async (db) => {
      await db.userPermissionOverride.create({ data: {
        organizationId: org, userId: actor, capability: 'reports:financial', effect: 'DENY', reason: 'Test denial',
      } });
      const reads = vi.spyOn(db.pharmacyFiscalDocument, 'findMany');
      try {
        await expect(readFiscalExceptions(context(db, org, actor), { ...filters, branchId: branch }))
          .rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(reads).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
        await db.userPermissionOverride.deleteMany({ where: { organizationId: org, userId: actor } });
      }
    });
  });
});
