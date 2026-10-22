/**
 * @vitest-environment node
 *
 * Loyalty settings writes against PostgreSQL as a NOSUPERUSER NOBYPASSRLS role, through
 * the real router and central can() over persisted pharmacy roles. A tenant without a
 * settings row has nothing for SELECT ... FOR UPDATE to lock, so two first writes used to
 * race: both audited "no previous settings" and the last writer won silently. Under the
 * tenant settings lock the second writer waits, reads the first's committed row, and the
 * audit chain is serial: each old value is the previous new value. The voucher settings
 * mutation takes the same lock, so a voucher write queued behind a points write sees it.
 *
 * Skipped unless TEST_DATABASE_URL names a migrated disposable database.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  ownerA: `user_loy3_owner_a_${suffix}`,
  ownerB: `user_loy3_owner_b_${suffix}`,
  manager: `user_loy3_manager_${suffix}`,
  denied: `user_loy3_denied_${suffix}`,
};
let scoped: typeof import('@/lib/tenancy/scoped-db');
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;
let orgSeq = 0;

const POINTS_A = {
  medicineEarnPoints: 2,
  nonDrugEarnPoints: 5,
  earnBlockMinor: 10_000,
  pointValueMinor: 100,
  minimumRedemptionPoints: 300,
  pointsExpiryMonths: 9,
  goldTierEnabled: false,
  goldTierThresholdMinor: 5_000_000,
  goldTierMultiplier: 2,
};
const POINTS_B = { ...POINTS_A, minimumRedemptionPoints: 400, pointsExpiryMonths: 12 };
const VOUCHERS = {
  voucherScope: 'NON_DRUG_ONLY' as const,
  voucherValidityDays: 45,
  maxIssuedPerCustomerPerPeriod: 4,
  maxIssuedPerPhonePerPeriod: 4,
  maxRedeemedPerCustomerPerPeriod: 4,
  maxRedeemedPerPhonePerPeriod: 4,
  abusePeriodDays: 20,
  expiryOverrideGraceDays: 0,
};

function caller(organizationId: string, userId: string, db: unknown) {
  return pharmacySalesRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: userId,
        role: 'EMPLOYEE',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId,
      },
    },
    organization: { id: organizationId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  } as never);
}

/** A fresh pharmacy organization with no settings row, and its persisted system roles. */
async function organization() {
  orgSeq += 1;
  const organizationId = `org_loy3_${suffix}_${orgSeq}`;
  const users = Object.fromEntries(
    Object.entries(ids).map(([key, id]) => [key, `${id}_${orgSeq}`])
  ) as typeof ids;
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { PHARMACY_ROLE_TEMPLATES } = await import('@/lib/vertical-catalog');
  await scoped.withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Loyalty 3', 'Loyalty 3', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  await scoped.withTenantDb(organizationId, async (tx) => {
    await seedDepartments(tx, [organizationId], ['LEADERSHIP']);
    const roleIds = new Map<string, string>();
    // Exactly what organization provisioning persists for each system role template.
    for (const template of PHARMACY_ROLE_TEMPLATES.filter((row) =>
      ['owner', 'manager'].includes(row.key)
    )) {
      const created = await tx.organizationRole.create({
        data: {
          organizationId,
          key: template.key,
          name: template.name,
          isSystem: template.isSystem,
          permissions: {
            create: template.capabilities.map((capability) => ({
              organizationId,
              capability,
              effect: 'ALLOW' as const,
            })),
          },
        },
      });
      roleIds.set(template.key, created.id);
    }
    for (const [id, roleKey] of [
      [users.ownerA, 'owner'],
      [users.ownerB, 'owner'],
      [users.manager, 'manager'],
      [users.denied, 'owner'],
    ] as const) {
      await tx.user.create({
        data: {
          id,
          name: id,
          email: `${id}@example.test`,
          department: 'LEADERSHIP',
          title: roleKey,
          role: 'EMPLOYEE',
          organizationRoleId: roleIds.get(roleKey)!,
        },
      });
    }
    await tx.userPermissionOverride.create({
      data: {
        organizationId,
        userId: users.denied,
        capability: 'pharmacy:loyalty-manage',
        effect: 'DENY',
        reason: 'Not trusted with loyalty policy',
        createdById: users.ownerA,
      },
    });
  });
  return { organizationId, users };
}

/** A tenant client whose next transaction runs its work, then waits uncommitted. */
function heldOpen(organizationId: string, userId: string) {
  const base = scoped.createTenantDb(organizationId, userId);
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const db = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return (work: (tx: ScopedDb) => Promise<unknown>) =>
        target.$transaction(async (tx) => {
          const result = await work(tx as ScopedDb);
          reached();
          await gate;
          return result;
        });
    },
  }) as ScopedDb;
  const holding = Promise.race([
    reachedPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  return { db, holding, commit: () => release() };
}

async function waitForLockWaiter() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [row] = await scoped.withPlatformDb(
      (db) =>
        db.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if ((row?.waiting ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function settingsState(organizationId: string) {
  return scoped.withTenantDb(organizationId, async (tx) => ({
    rows: await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT "minimumRedemptionPoints", "pointsExpiryMonths", "voucherScope"::text AS "voucherScope"
      FROM pharmacy_loyalty_settings`,
    audits: await tx.$queryRaw<
      Array<{
        actorId: string;
        oldValue: Record<string, unknown>;
        newValue: Record<string, unknown>;
      }>
    >`SELECT "actorId", "oldValue", "newValue" FROM pharmacy_loyalty_settings_audits
      ORDER BY "occurredAt", id`,
  }));
}

beforeAll(async () => {
  if (!databaseUrl) return;
  scoped = await import('@/lib/tenancy/scoped-db');
  pharmacySalesRouter = (await import('./pharmacy-sales')).pharmacySalesRouter;
  const { db } = await import('@/lib/db');
  disconnect = () => db.$disconnect();
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
}, 60_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('loyalty settings writes are serialized per tenant (FORCE RLS)', () => {
  it('two concurrent first writes: one row, and a serial old/new audit chain', async () => {
    const { organizationId, users } = await organization();
    const first = heldOpen(organizationId, users.ownerA);
    const firstWrite = caller(organizationId, users.ownerA, first.db).updateLoyaltyPointsSettings(
      POINTS_A
    );
    const holding = await first.holding;
    const secondWrite = caller(
      organizationId,
      users.ownerB,
      scoped.createTenantDb(organizationId, users.ownerB)
    ).updateLoyaltyPointsSettings(POINTS_B);
    const waited = holding ? await waitForLockWaiter() : false;
    first.commit();
    await Promise.all([firstWrite, secondWrite]);

    expect(holding).toBe(true);
    expect(waited).toBe(true);
    const state = await settingsState(organizationId);
    expect(state.rows).toEqual([
      { minimumRedemptionPoints: 400, pointsExpiryMonths: 12, voucherScope: 'WHOLE_BASKET' },
    ]);
    expect(state.audits.map((audit) => audit.actorId)).toEqual([users.ownerA, users.ownerB]);
    const [a, b] = state.audits;
    // The first write replaced the defaults; the second replaced exactly the first's result.
    expect(a!.oldValue).toMatchObject({ minimumRedemptionPoints: 200, pointsExpiryMonths: 6 });
    expect(a!.newValue).toMatchObject({ minimumRedemptionPoints: 300, pointsExpiryMonths: 9 });
    expect(b!.oldValue).toEqual(a!.newValue);
    expect(b!.newValue).toMatchObject({ minimumRedemptionPoints: 400, pointsExpiryMonths: 12 });
  });

  it('a voucher settings write queued behind a points write reads its committed row', async () => {
    const { organizationId, users } = await organization();
    const first = heldOpen(organizationId, users.ownerA);
    const pointsWrite = caller(organizationId, users.ownerA, first.db).updateLoyaltyPointsSettings(
      POINTS_A
    );
    const holding = await first.holding;
    const voucherWrite = caller(
      organizationId,
      users.ownerB,
      scoped.createTenantDb(organizationId, users.ownerB)
    ).updateLoyaltySettings(VOUCHERS);
    const waited = holding ? await waitForLockWaiter() : false;
    first.commit();
    await Promise.all([pointsWrite, voucherWrite]);

    expect(holding).toBe(true);
    expect(waited).toBe(true);
    const state = await settingsState(organizationId);
    expect(state.rows).toEqual([
      { minimumRedemptionPoints: 300, pointsExpiryMonths: 9, voucherScope: 'NON_DRUG_ONLY' },
    ]);
    expect(state.audits[1]!.oldValue).toMatchObject({
      minimumRedemptionPoints: 300,
      pointsExpiryMonths: 9,
    });
  });

  it('lets the persisted Owner write and refuses a Manager and a user DENY, writing nothing', async () => {
    const { organizationId, users } = await organization();
    const as = (userId: string) =>
      caller(organizationId, userId, scoped.createTenantDb(organizationId, userId));
    await expect(as(users.manager).updateLoyaltyPointsSettings(POINTS_A)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(as(users.denied).updateLoyaltyPointsSettings(POINTS_A)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await settingsState(organizationId)).toEqual({ rows: [], audits: [] });
    await expect(as(users.ownerA).updateLoyaltyPointsSettings(POINTS_A)).resolves.toEqual(POINTS_A);
    expect((await settingsState(organizationId)).audits).toHaveLength(1);
  });
});
