import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const runtimeUrl = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
const ownerUrl =
  process.env.M8_TEST_OWNER_DATABASE_URL ?? process.env.WHA566_OWNER_DATABASE_URL ?? '';
// Skipped, never silently passed, until both URLs name a disposable database.
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
if (runtimeUrl && runtimeUrl === ownerUrl)
  throw new Error('Runtime and owner database URLs must differ');
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;

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

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let restaurantTaxRouter: typeof import('./restaurant-tax').restaurantTaxRouter;

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const organizationId = `tax_activation_org_${suffix}`;
const branchId = `tax_activation_branch_${suffix}`;
const customBranchId = `tax_custom_branch_${suffix}`;
const otherOrganizationId = `tax_other_org_${suffix}`;
const otherBranchId = `tax_other_branch_${suffix}`;
const owner = new pg.Client({ connectionString: ownerUrl });

function caller(db: ScopedDb) {
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
  effectiveFrom: '2031-07-01',
  accountantConfirmation: true,
  approvalReference: 'Concurrent activation test',
  eligibilityConfirmations: ['ictNoInputTaxCreditOrAdjustment', 'ictNoRefund'],
  idempotencyKey: `activation-${suffix}`,
};

describeIfDatabase('restaurant tax activation replay against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ restaurantTaxRouter } = await import('./restaurant-tax'));
    await owner.connect();
    await owner.query(`SET app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
      [organizationId]
    );
    await owner.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,timezone,"updatedAt") VALUES ($1,$2,'Islamabad','Asia/Karachi',now())`,
      [branchId, organizationId]
    );
    await owner.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,timezone,"updatedAt") VALUES ($1,$2,'Karachi','Asia/Karachi',now())`,
      [customBranchId, organizationId]
    );
    await owner.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
      [otherOrganizationId]
    );
    await owner.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,timezone,"updatedAt") VALUES ($1,$2,'Other tenant','Asia/Karachi',now())`,
      [otherBranchId, otherOrganizationId]
    );
  });

  // The organizations stay behind: activation writes append-only tax sources
  // (tax_source_immutable) whose visibility FK restricts the organization
  // delete. Every id is suffixed per run, so leftovers never collide.
  afterAll(async () => {
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
    expect(results[0].effectiveFrom).toEqual(new Date('2031-06-30T19:00:00.000Z'));
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

  it('atomically replaces an open profile through preset activation', async () => {
    // Activation accepts an ISO business date; it starts at Karachi midnight.
    const replacementFrom = '2032-01-01';
    const successor = await withTenantDb(organizationId, (db) =>
      caller(db).activate({
        ...input,
        effectiveFrom: replacementFrom,
        replaceOpenProfile: true,
        idempotencyKey: `activation-successor-${suffix}`,
      })
    );

    await withTenantDb(organizationId, async (db) => {
      const profiles = await db.restaurantTaxProfileVersion.findMany({
        where: { branchId },
        include: { rules: true },
        orderBy: { effectiveFrom: 'asc' },
      });
      expect(profiles).toHaveLength(2);
      expect(profiles[0].effectiveTo).toEqual(successor.effectiveFrom);
      expect(profiles[0].rules).toHaveLength(3);
      expect(profiles[0].rules.map((rule) => rule.effectiveTo)).toEqual(
        Array(3).fill(successor.effectiveFrom)
      );
      expect(profiles[1]).toMatchObject({
        id: successor.id,
        presetId: input.profileId,
        effectiveFrom: new Date('2031-12-31T19:00:00.000Z'),
        effectiveTo: null,
      });
      expect(profiles[1].rules.every((rule) => rule.effectiveTo === null)).toBe(true);
    });
  });

  it('publishes one customer-supplied profile with canonical evidence at Karachi midnight', async () => {
    const customInput = {
      branchId: customBranchId,
      profileName: 'Accountant supplied Sindh profile',
      jurisdictionCode: 'PK-SD' as const,
      effectiveFrom: '2032-07-01',
      priceMode: 'INCLUSIVE' as const,
      rates: [
        { paymentCategory: 'OTHER', rate: '0.160000' },
        { paymentCategory: 'CASH', rate: '0.150000' },
        { paymentCategory: 'CARD', rate: '0.050000' },
      ],
      approvalReference: 'Accountant memo 864',
      accountantConfirmation: true as const,
      replaceOpenProfile: false,
      idempotencyKey: `custom-${suffix}`,
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        withTenantDb(organizationId, (db) => caller(db).publishCustom(customInput))
      )
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);

    await withTenantDb(organizationId, async (db) => {
      const profile = await db.restaurantTaxProfileVersion.findUniqueOrThrow({
        where: { id: results[0].id },
        include: { rules: { include: { officialSource: true } } },
      });
      expect(profile).toMatchObject({
        branchId: customBranchId,
        profileName: customInput.profileName,
        jurisdictionCode: 'PK-SD',
        priceMode: 'INCLUSIVE',
        evidenceKind: 'CUSTOMER_SUPPLIED',
        effectiveFrom: new Date('2032-06-30T19:00:00.000Z'),
      });
      expect(profile.rules.map((rule) => rule.paymentCategory).sort()).toEqual([
        'CARD',
        'CASH',
        'OTHER',
      ]);
      expect(new Set(profile.rules.map((rule) => rule.officialSource.contentHash))).toEqual(
        new Set([profile.activationPayloadHash])
      );
      expect(profile.rules[0].officialSource.documentTitle).toContain('not an official instrument');
    });

    await expect(
      withTenantDb(organizationId, (db) =>
        caller(db).publishCustom({ ...customInput, profileName: 'Changed semantic payload' })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('atomically replaces once and rejects reopening or extending the closed profile', async () => {
    const successor = await withTenantDb(organizationId, (db) =>
      caller(db).publishCustom({
        branchId: customBranchId,
        profileName: 'Successor profile',
        jurisdictionCode: 'PK-SD',
        effectiveFrom: '2033-07-01',
        priceMode: 'EXCLUSIVE',
        rates: [
          { paymentCategory: 'CASH', rate: '0.14' },
          { paymentCategory: 'CARD', rate: '0.04' },
          { paymentCategory: 'OTHER', rate: '0.15' },
        ],
        approvalReference: 'Replacement memo 864',
        accountantConfirmation: true,
        replaceOpenProfile: true,
        idempotencyKey: `successor-${suffix}`,
      })
    );
    const profiles = await withTenantDb(organizationId, (db) =>
      db.restaurantTaxProfileVersion.findMany({
        where: { branchId: customBranchId },
        orderBy: { effectiveFrom: 'asc' },
      })
    );
    expect(profiles).toHaveLength(2);
    expect(profiles[0].effectiveTo).toEqual(successor.effectiveFrom);
    expect(profiles[1].effectiveTo).toBeNull();
    await withTenantDb(organizationId, async (db) => {
      await expect(
        db.restaurantTaxProfileVersion.update({
          where: { id: profiles[0].id },
          data: { effectiveTo: null },
        })
      ).rejects.toThrow(/published tax version is immutable/);
    });
    await withTenantDb(organizationId, async (db) => {
      await expect(
        db.restaurantTaxProfileVersion.update({
          where: { id: profiles[0].id },
          data: { effectiveTo: new Date('2034-01-01T00:00:00.000Z') },
        })
      ).rejects.toThrow(/published tax version is immutable/);
    });
  });

  it('does not reveal or write through a branch owned by another tenant', async () => {
    await expect(
      withTenantDb(organizationId, (db) =>
        caller(db).publishCustom({
          branchId: otherBranchId,
          profileName: 'Cross tenant attempt',
          jurisdictionCode: 'PK-ICT',
          effectiveFrom: '2035-01-01',
          priceMode: 'EXCLUSIVE',
          rates: [
            { paymentCategory: 'CASH', rate: '0.1' },
            { paymentCategory: 'CARD', rate: '0.1' },
            { paymentCategory: 'OTHER', rate: '0.1' },
          ],
          approvalReference: 'Must not persist',
          accountantConfirmation: true,
          replaceOpenProfile: false,
          idempotencyKey: `cross-tenant-${suffix}`,
        })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const count = await owner.query<{ count: string }>(
      `SELECT count(*) FROM restaurant_tax_profile_versions WHERE "branchId" = $1`,
      [otherBranchId]
    );
    expect(count.rows[0].count).toBe('0');
  });
});
