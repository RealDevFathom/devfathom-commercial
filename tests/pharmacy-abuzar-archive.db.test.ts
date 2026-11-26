// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

describe.runIf(process.env.TEST_DATABASE_URL)('Abuzar import storage in PostgreSQL', () => {
  it('requires tenant scope for every imported record and keeps history append-only', async () => {
    const url = process.env.TEST_DATABASE_URL!;
    assertDisposableRlsDatabase(url);
    const { withPlatformDb, withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(withPlatformDb);
    const a = randomUUID(),
      b = randomUUID();
    for (const org of [a, b])
      await withPlatformDb((db) =>
        db.organization.create({
          data: { id: org, slug: org, displayName: org, legalName: org, vertical: 'PHARMACY' },
        })
      );
    await withTenantDb(a, async (db) => {
      const policies = await db.$queryRaw<
        { relname: string; rls: boolean; forced: boolean }[]
      >`SELECT relname,relrowsecurity AS rls,relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('pharmacy_abuzar_parties','pharmacy_abuzar_history') ORDER BY relname`;
      expect(policies).toEqual([
        { relname: 'pharmacy_abuzar_history', rls: true, forced: true },
        { relname: 'pharmacy_abuzar_parties', rls: true, forced: true },
      ]);
      const branch = await db.pharmacyBranch.create({
        data: {
          name: 'Synthetic branch',
          code: 'AB',
          addressLine: 'QA',
          city: 'QA',
          provinceCode: 'PB',
        },
      });
      await db.$executeRaw`INSERT INTO pharmacy_abuzar_history ("organizationId","branchId","sourceId","sourceBranch",kind,"documentNo","documentDate",quantity,"unitPrice",amount,"rowHash") VALUES (${a},${branch.id},'h1','B1','sale','H-123','2025-10-15','2','4.50','9.00',repeat('a',64))`;
    });
    expect(
      await withTenantDb(b, (db) => db.$queryRaw`SELECT "documentNo" FROM pharmacy_abuzar_history`)
    ).toEqual([]);
    expect(
      await withTenantDb(
        a,
        (db) => db.$queryRaw`SELECT "documentNo",label FROM pharmacy_abuzar_history`
      )
    ).toEqual([{ documentNo: 'H-123', label: 'Imported from Abuzar' }]);
    // The archive exposes no writable policy for existing rows.
    expect(
      await withTenantDb(
        a,
        (db) =>
          db.$executeRaw`UPDATE pharmacy_abuzar_history SET amount='8.00' WHERE "sourceId"='h1'`
      )
    ).toBe(0);
  });
});

describe.runIf(process.env.TEST_DATABASE_URL)('prepared party and history operations', () => {
  it('previews, confirms and replays with identical persisted rows, without posting history', async () => {
    const { runAbuzarStep } = await import('@/lib/pharmacy/migration/abuzar-run');
    const { withPlatformDb, withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { seedDepartments } = await import('@/lib/test-support/departments');
    const org = randomUUID();
    await withPlatformDb((db) =>
      db.organization.create({
        data: { id: org, slug: org, displayName: org, legalName: org, vertical: 'PHARMACY' },
      })
    );
    const scope = await withTenantDb(org, async (db) => {
      await seedDepartments(db, [org], ['QA']);
      const user = await db.user.create({
        data: {
          name: 'Synthetic owner',
          email: org + '@example.test',
          department: 'QA',
          title: 'QA',
        },
      });
      const branch = await db.pharmacyBranch.create({
        data: { name: 'QA', code: 'QA', addressLine: 'QA', city: 'QA', provinceCode: 'PB' },
      });
      return { organizationId: org, branchId: branch.id, actorId: user.id };
    });
    const { readPreparedExport } = await import('../tools/abuzar-import/prepared');
    const { syntheticExport } = await import('./fixtures/abuzar-prepared');
    const data = await readPreparedExport(await syntheticExport());
    const snapshot = () =>
      withTenantDb(
        org,
        async (db) =>
          (
            await db.$queryRaw<Record<string, unknown>[]>`SELECT
        (SELECT count(*)::int FROM pharmacy_customers) customers,(SELECT count(*)::int FROM pharmacy_abuzar_history) history,
        (SELECT count(*)::int FROM pharmacy_sales) sales, (SELECT count(*)::int FROM finance_journal_entries) journals,
        (SELECT md5(string_agg(t::text,',' ORDER BY t."sourceId")) FROM pharmacy_abuzar_history t) checksum,
        (SELECT count(*)::int FROM audit_logs WHERE action LIKE 'pharmacy.abuzar.%') audit`
          )[0]
      );
    expect(await snapshot()).toMatchObject({
      customers: 0,
      history: 0,
      sales: 0,
      journals: 0,
      audit: 0,
    });
    for (const step of ['parties', 'history'] as const) {
      const options = { step, sourceBranch: 'B1', addToExisting: false };
      const run = (confirmation?: string) =>
        withTenantDb(org, (db) => runAbuzarStep(db, scope, data, options, confirmation));
      const before = await snapshot();
      const dry = await run();
      expect(dry.create).toBe(1);
      expect(await snapshot()).toEqual(before);
      await expect(run('0'.repeat(64))).rejects.toThrow(/dry run/i);
      const real = await run(dry.confirmation);
      expect(real.applied).toBe(1);
      const after = await snapshot();
      expect((await run(dry.confirmation)).applied).toBe(0);
      expect(await snapshot()).toEqual(after);
    }
    expect(await snapshot()).toMatchObject({
      customers: 1,
      history: 1,
      sales: 0,
      journals: 0,
      audit: 2,
      checksum: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    expect(
      await withTenantDb(org, (db) => db.pharmacyPatient.findFirst({ select: { phone: true } }))
    ).toEqual({ phone: '+923001234567' });
    await withTenantDb(org, (db) =>
      db.pharmacyAccountingPeriod.create({
        data: {
          organizationId: org,
          branchId: scope.branchId,
          startsAt: new Date('2026-11-01Z'),
          endsAt: new Date('2026-12-01Z'),
          status: 'OPEN',
        },
      })
    );
    const opening = (confirmation?: string) =>
      withTenantDb(org, (db) =>
        runAbuzarStep(
          db,
          scope,
          data,
          { step: 'balances', sourceBranch: 'B1', addToExisting: false, cutover: '2026-11-26' },
          confirmation
        )
      );
    const preview = await opening();
    expect(preview.effects.customerBalanceMinor).toBe('1250');
    expect((await opening(preview.confirmation)).applied).toBe(1);
    expect((await opening(preview.confirmation)).applied).toBe(0);
    expect(await snapshot()).toMatchObject({ journals: 1, audit: 3, sales: 0 });
  });
});
