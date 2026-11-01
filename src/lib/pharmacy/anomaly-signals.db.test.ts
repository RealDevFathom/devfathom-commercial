/**
 * AI-04 storage proof against migrated PostgreSQL. Skipped, never silently
 * passed, when no disposable runtime database is configured. The role check is
 * first because SUPERUSER/BYPASSRLS would invalidate every isolation claim.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1314_a_${suffix}`;
const ORG_B = `org_wha1314_b_${suffix}`;
const BRANCH_A = `branch_wha1314_a_${suffix}`;
const BRANCH_B = `branch_wha1314_b_${suffix}`;
const NOW = new Date('2026-09-04T12:00:00.000Z');

let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];

async function inOrg<T>(organizationId: string, run: (db: ScopedDb) => Promise<T>) {
  return withTenantDb(organizationId, run);
}

async function createFixture(organizationId: string, branchId: string) {
  return inOrg(organizationId, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: branchId,
        name: branchId,
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    return db.pharmacyAnomalySignal.create({
      data: {
        branchId,
        kind: 'CASH_VARIANCE',
        dedupKey: `cash:${branchId}`,
        severity: 'REVIEW',
        scope: { branchId },
        policyVersion: 'AI04-2026-09-04',
        exactNumbers: { expectedMinor: 200_000, countedMinor: 100_000, varianceMinor: -100_000 },
        explanation: 'Review-only cash variance fixture.',
        dataWindowStart: NOW,
        dataWindowEnd: NOW,
        sourceObservedAt: NOW,
        freshnessSeconds: 3_600,
        computedAt: NOW,
      },
    });
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const roleGuard = await import('@/lib/testing/rls-role-guard');
  withTenantDb = scoped.withTenantDb;
  await roleGuard.assertRlsEnforcingRole(scoped.withPlatformDb);
}, 120_000);

describeIfDatabase('AI-04 anomaly tenant and branch RLS', () => {
  it('runs as neither SUPERUSER nor BYPASSRLS and isolates signal/event rows', async () => {
    const a = await createFixture(ORG_A, BRANCH_A);
    const b = await createFixture(ORG_B, BRANCH_B);

    await inOrg(ORG_A, async (db) => {
      const role = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      expect(await db.pharmacyAnomalySignal.count()).toBe(1);
      expect(await db.pharmacyAnomalySignal.count({ where: { id: b.id } })).toBe(0);
      await db.pharmacyAnomalySignalEvent.create({
        data: {
          branchId: BRANCH_A,
          signalId: a.id,
          kind: 'ACKNOWLEDGED',
          actorId: 'owner_a',
          reason: 'Count sheet reviewed',
        },
      });
      expect(await db.pharmacyAnomalySignalEvent.count()).toBe(1);
    });
    await inOrg(ORG_B, async (db) => {
      expect(await db.pharmacyAnomalySignal.count()).toBe(1);
      expect(await db.pharmacyAnomalySignalEvent.count()).toBe(0);
    });
  });

  it('keeps decision events append-only and signal roots undeletable', async () => {
    const signal = await inOrg(ORG_A, (db) =>
      db.pharmacyAnomalySignal.findFirstOrThrow({ where: { branchId: BRANCH_A } })
    );
    const event = await inOrg(ORG_A, (db) => db.pharmacyAnomalySignalEvent.findFirstOrThrow());
    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyAnomalySignalEvent.update({
          where: { id: event.id },
          data: { reason: 'rewritten' },
        })
      )
    ).rejects.toThrow(/append-only/i);
    await expect(
      inOrg(ORG_A, (db) => db.pharmacyAnomalySignal.delete({ where: { id: signal.id } }))
    ).rejects.toThrow(/never hard-deleted/i);
  });

  it('persists both new anomaly kinds without changing existing signal kinds', async () => {
    await inOrg(ORG_A, async (db) => {
      const original = await db.pharmacyAnomalySignal.findFirstOrThrow({
        where: { branchId: BRANCH_A },
      });
      for (const kind of ['VOID_ABUSE', 'TENDER_MISMATCH'] as const) {
        const signal = await db.pharmacyAnomalySignal.create({
          data: {
            branchId: BRANCH_A,
            kind,
            dedupKey: `${kind}:${suffix}`,
            severity: 'REVIEW',
            scope: { branchId: BRANCH_A, userId: 'cashier_a' },
            policyVersion: 'AI04-2026-10-29',
            exactNumbers: {},
            explanation: 'Review-only enum persistence fixture.',
            dataWindowStart: NOW,
            dataWindowEnd: NOW,
            sourceObservedAt: NOW,
            freshnessSeconds: 3_600,
            computedAt: NOW,
          },
        });
        expect(signal.kind).toBe(kind);
      }
      expect(
        await db.pharmacyAnomalySignal.findUniqueOrThrow({ where: { id: original.id } })
      ).toMatchObject({ kind: 'CASH_VARIANCE' });
    });
  });
});
