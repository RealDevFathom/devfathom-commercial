/** Run only against a newly owned, migrated disposable DB via TEST_DATABASE_URL. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const commandCentre = vi.hoisted(() => vi.fn());
vi.mock('./reports', () => ({ readPharmacyOwnerCommandCentre: commandCentre }));
import { readPharmacyBranchComparison } from './branch-comparison';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const org = `branch_compare_${randomUUID()}`;
const otherOrg = `${org}_other`;
const branch = `${org}_branch`;
const otherBranch = `${otherOrg}_branch`;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  withTenantDb = scoped.withTenantDb;

  await scoped.withPlatformDb(async (db) => {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [org, otherOrg]
    );
  });

  for (const organizationId of [org, otherOrg]) {
    const fixtureBranch = organizationId === org ? branch : otherBranch;
    await withTenantDb(organizationId, async (db: ScopedDb) => {
      await db.pharmacyBranch.create({
        data: {
          id: fixtureBranch,
          organizationId,
          code: organizationId,
          name: organizationId,
          addressLine: '1 Test Street',
          city: 'Test City',
          provinceCode: 'TS',
        },
      });
      await db.unfulfilledDemandEvent.create({
        data: {
          organizationId,
          branchId: fixtureBranch,
          saleUnit: 'PACK',
          quantity: 1,
          reason: 'STOCKOUT',
          requestedText: 'Requested test medicine',
          inventoryRuleSnapshot: {},
          estimatedValueMinor: organizationId === org ? 1200 : 9900,
          capturedByUserId: 'fixture-user',
          createdAt: new Date('2026-10-03T12:00:00Z'),
        },
      });
    });
  }
  commandCentre.mockResolvedValue({
    metrics: { salesMinor: 0, marginMinor: 0, expiryValueMinor30: 0, khataAgingMinor: 0 },
  });
}, 30_000);

suite('branch comparison demand aggregate under forced PostgreSQL RLS', () => {
  it('does not expose a requested branch row from another tenant', async () => {
    const result = await withTenantDb(org, (db: ScopedDb) =>
      readPharmacyBranchComparison(db, {
        branches: [
          { id: branch, name: 'Current tenant' },
          { id: otherBranch, name: 'Foreign tenant' },
        ],
        from: '2026-10-01',
        to: '2026-10-07',
      })
    );

    expect(result.rows[0]).toMatchObject({
      lostDemandEstimateMinor: 1200,
      lostDemandRecordedEvents: 1,
    });
    expect(result.rows[1]).toMatchObject({
      lostDemandEstimateMinor: null,
      lostDemandRecordedEvents: 0,
    });
  });
});
