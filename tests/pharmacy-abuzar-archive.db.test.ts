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
