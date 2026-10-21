/**
 * MED-06 persistence proof against migrated PostgreSQL. The focused command
 * supplies a disposable restricted runtime role, so this suite must execute
 * with zero skipped tests.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.WHA1339_TEST_RUNTIME_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1339_a_${suffix}`;
const ORG_B = `org_wha1339_b_${suffix}`;

let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];

async function inOrg<T>(organizationId: string, run: (db: ScopedDb) => Promise<T>) {
  return withTenantDb(organizationId, run);
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const roleGuard = await import('@/lib/testing/rls-role-guard');
  withTenantDb = scoped.withTenantDb;
  await roleGuard.assertRlsEnforcingRole(scoped.withPlatformDb);
}, 120_000);

describeIfDatabase('MED-06 connector run and proposal RLS', () => {
  it('uses a LOGIN NOSUPERUSER NOBYPASSRLS role and hides another organization state', async () => {
    const fixture = await inOrg(ORG_A, async (db) => {
      const role = await db.$queryRaw<
        Array<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>
      >`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      expect(role).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);

      const connector = await db.pharmacyReferenceConnector.create({
        data: {
          key: 'manual-file',
          label: 'Manual CSV / Excel',
          schedule: { kind: 'MANUAL' },
          createdBy: 'admin-a',
        },
      });
      const run = await db.pharmacyReferenceConnectorRun.create({
        data: {
          connectorId: connector.id,
          inputDigest: 'a'.repeat(64),
          batchId: 'batch-a',
          fileName: 'catalog.csv',
          triggerKind: 'MANUAL',
          triggeredBy: 'admin-a',
          rejectionReasons: [],
        },
      });
      const proposal = await db.pharmacyReferenceConnectorProposal.create({
        data: {
          runId: run.id,
          connectorId: connector.id,
          inputDigest: run.inputDigest,
          rowSourceKey: 'row-a',
          payload: { values: { productName: 'Proposed medicine' } },
        },
      });
      return { connector, run, proposal };
    });

    await inOrg(ORG_B, async (db) => {
      expect(await db.pharmacyReferenceConnector.count()).toBe(0);
      expect(await db.pharmacyReferenceConnectorRun.count()).toBe(0);
      expect(await db.pharmacyReferenceConnectorProposal.count()).toBe(0);
      expect(
        await db.pharmacyReferenceConnector.findFirst({ where: { id: fixture.connector.id } })
      ).toBeNull();
    });
  });

  it('keeps run evidence and decided proposals immutable', async () => {
    const decided = await inOrg(ORG_A, async (db) => {
      const proposal = await db.pharmacyReferenceConnectorProposal.findFirstOrThrow();
      return db.pharmacyReferenceConnectorProposal.update({
        where: { id: proposal.id },
        data: { status: 'REJECTED', decidedBy: 'pharmacist-a', decidedAt: new Date() },
      });
    });
    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyReferenceConnectorProposal.update({
          where: { id: decided.id },
          data: { payload: { values: { productName: 'Rewritten' } } },
        })
      )
    ).rejects.toThrow(/immutable after one decision/i);
    await expect(
      inOrg(ORG_A, async (db) => {
        const run = await db.pharmacyReferenceConnectorRun.findFirstOrThrow();
        return db.pharmacyReferenceConnectorRun.delete({ where: { id: run.id } });
      })
    ).rejects.toThrow(/audit records/i);
  });
});
