import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { restaurantTaxRouter } from './restaurant-tax';

const ownerUrl = process.env.WHA566_OWNER_DATABASE_URL;
if (!ownerUrl) throw new Error('WHA566_OWNER_DATABASE_URL is required');

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const organizationId = `tax_activation_org_${suffix}`;
const branchId = `tax_activation_branch_${suffix}`;
const owner = new pg.Client({ connectionString: ownerUrl });

function caller(db: Parameters<Parameters<typeof withTenantDb>[1]>[0]) {
  return restaurantTaxRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['restaurant-core'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: 'admin_1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId,
      },
    },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

const input = {
  branchId,
  profileId: 'PK-ICT-RESTAURANT',
  effectiveFrom: '2031-07-01T00:00:00.000Z',
  accountantConfirmation: true,
  approvalReference: 'Concurrent activation test',
  eligibilityConfirmations: ['ictNoInputTaxCreditOrAdjustment', 'ictNoRefund'],
  idempotencyKey: `activation-${suffix}`,
};

describe('restaurant tax activation replay against PostgreSQL', () => {
  beforeAll(async () => {
    await owner.connect();
    await owner.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
      [organizationId]
    );
    await owner.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,"updatedAt") VALUES ($1,$2,'Islamabad',now())`,
      [branchId, organizationId]
    );
  });

  afterAll(async () => {
    await owner.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    await owner.end();
  });

  it('uses a restricted runtime role', async () => {
    await withTenantDb(organizationId, async (db) => {
      const rows = await db.$queryRaw<
        { rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]
      >`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
    });
  });

  it('returns one original version for true concurrent matching retries', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        withTenantDb(organizationId, (db) => caller(db).activate(input))
      )
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    await withTenantDb(organizationId, async (db) => {
      expect(await db.restaurantTaxProfileVersion.count({ where: { branchId } })).toBe(1);
      expect(
        await db.restaurantTaxRuleVersion.count({ where: { profileVersionId: results[0].id } })
      ).toBe(3);
    });
  });

  it('replays the original and conflicts for the same key with a different payload', async () => {
    await expect(
      withTenantDb(organizationId, (db) => caller(db).activate(input))
    ).resolves.toMatchObject({ id: expect.any(String) });
    await expect(
      withTenantDb(organizationId, (db) =>
        caller(db).activate({ ...input, approvalReference: 'Different payload' })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
