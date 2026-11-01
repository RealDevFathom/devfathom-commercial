/**
 * @vitest-environment node
 *
 * The pharmacy drawer and close procedures against a REAL migrated PostgreSQL,
 * through the real router, each call in its own tenant transaction the way each
 * HTTP request runs.
 *
 * These procedures take `branchId` from the input. A branch of another tenant is
 * invisible under forced row-level security, and the composite visibility foreign
 * key stops it being written — but neither stops a DEACTIVATED branch of the
 * caller's own organization: its open drawer could take cash movements and be
 * closed, and it could be cut a daily close. `scopeFor` refuses a branch that is
 * not an active branch of the caller's organization; every one of these
 * procedures must reach that refusal before it reads or writes anything. And the
 * close family's typed refusals (a drawer still open, a second cut without a
 * reason) must reach the caller as typed errors, the way the drawer family's do.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first).
 * Without it the suite reports itself skipped rather than passing vacuously.
 * Only the web identity boundary and the audit row write are stubbed; the
 * database client is the application's own (`@/lib/db`), whose transaction
 * wrapper issues the day lock's `pg_advisory_xact_lock` without decoding void.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// `@/lib/db` reads DATABASE_URL on first use; everything that reaches it is
// imported inside the suite, after this line.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `harden_drawer_a_${suffix}`;
const OTHER_ORG = `harden_drawer_b_${suffix}`;
/** Active branch of ORG. */
const ACTIVE = `harden_branch_active_${suffix}`;
/** Branch of ORG that was deactivated while a drawer stood open on it. */
const RETIRED = `harden_branch_retired_${suffix}`;
/** Active branch of OTHER_ORG. */
const FOREIGN = `harden_branch_foreign_${suffix}`;
const UNKNOWN = `harden_branch_unknown_${suffix}`;
const ACTOR = `harden_actor_${suffix}`;
const DEVICE = 'counter-device-1';
const businessDate = new Date('2026-10-20T00:00:00.000Z');
type Refusal = { code: string; message: string };
/** `scopeFor`'s refusal. */
const NOT_IN_WORKSPACE: Refusal = {
  code: 'BAD_REQUEST',
  message: 'That record is not in this workspace.',
};
/** The same refusal, as the counter's receipt-access path words it. */
const OUTSIDE: Refusal = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
let retiredDrawerId = '';

/** The pharmacy sales procedures as ORG's administrator calls them, on one request's transaction. */
async function sales(db: ScopedDb) {
  const { pharmacySalesRouter } = await import('./pharmacy-sales');
  return pharmacySalesRouter.createCaller({
    db,
    entitlements: {
      organizationId: ORG,
      enabledModules: ['pharmacy-core', 'pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: { id: ACTOR, role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
    },
    organization: { id: ORG, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

/** One request: ORG's administrator, in ORG's tenant transaction. */
function asAdmin<T>(run: (caller: Awaited<ReturnType<typeof sales>>) => Promise<T>): Promise<T> {
  return withTenantDb(ORG, async (db) => run(await sales(db)), { userId: ACTOR });
}

async function createBranch(organizationId: string, id: string) {
  await withTenantDb(organizationId, (db) =>
    db.pharmacyBranch.create({
      data: {
        id,
        organizationId,
        code: id,
        name: `Branch ${id}`,
        addressLine: '1 Synthetic Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    })
  );
}

/**
 * What the drawer and close tables hold for a branch, as one organization reads
 * them: the sales tables have no platform-admin exception, and a write ORG's
 * requests made could only carry ORG's organization id.
 */
async function rowsFor(branchId: string, organizationId = ORG) {
  const [row] = await withTenantDb(organizationId, (db) =>
    db.$queryRawUnsafe<Array<Record<string, bigint>>>(
      `SELECT (SELECT count(*) FROM pharmacy_drawer_sessions WHERE "branchId" = $1) AS drawers,
              (SELECT count(*) FROM pharmacy_drawer_movements m
                 JOIN pharmacy_drawer_sessions s ON s.id = m."drawerSessionId"
                WHERE s."branchId" = $1) AS movements,
              (SELECT count(*) FROM pharmacy_drawer_sessions
                WHERE "branchId" = $1 AND status = 'CLOSED') AS closed,
              (SELECT count(*) FROM pharmacy_daily_closes WHERE "branchId" = $1) AS closes`,
      branchId
    )
  );
  return Object.fromEntries(Object.entries(row!).map(([key, value]) => [key, Number(value)]));
}

describeIfDatabase('pharmacy drawer and close procedures, against PostgreSQL', () => {
  beforeAll(async () => {
    const scoped = await import('@/lib/tenancy/scoped-db');
    withTenantDb = scoped.withTenantDb;
    withPlatformDb = scoped.withPlatformDb;
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(withPlatformDb);
    await withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id`,
        [ORG, OTHER_ORG]
      )
    );
    // A workspace zone other than the default, the runner's and Asia/Karachi.
    await withPlatformDb((db) =>
      db.organization.update({
        where: { id: ORG },
        data: { currency: 'USD', timezone: 'America/Chicago' },
      })
    );
    await createBranch(ORG, ACTIVE);
    await createBranch(ORG, RETIRED);
    await createBranch(OTHER_ORG, FOREIGN);
    await withTenantDb(ORG, async (db) => {
      await db.organizationDepartment.create({ data: { key: 'PHARMACY', name: 'PHARMACY' } });
      const role = await db.organizationRole.create({
        data: { key: 'owner', name: 'Owner', isSystem: true },
      });
      await db.user.create({
        data: {
          id: ACTOR,
          email: `${ACTOR}@example.invalid`,
          name: 'Drawer actor',
          department: 'PHARMACY',
          title: 'Owner',
          role: 'ADMIN',
          organizationRoleId: role.id,
        },
      });
    });
    // A drawer opened while the branch traded, then the branch was deactivated.
    const drawer = await asAdmin((c) =>
      c.openDrawer({ branchId: RETIRED, deviceId: DEVICE, businessDate, openingFloatMinor: 500 })
    );
    retiredDrawerId = drawer!.id;
    await withTenantDb(ORG, (db) =>
      db.pharmacyBranch.update({ where: { id: RETIRED }, data: { active: false } })
    );
  }, 120_000);

  const procedures = (branchId: string, drawerSessionId: string) =>
    [
      ['drawerStatus', (c) => c.drawerStatus({ branchId, deviceId: DEVICE }), NOT_IN_WORKSPACE],
      [
        'openDrawer',
        (c) =>
          c.openDrawer({
            branchId,
            deviceId: 'counter-device-2',
            businessDate,
            openingFloatMinor: 0,
          }),
        NOT_IN_WORKSPACE,
      ],
      [
        'drawerMovement',
        (c) =>
          c.drawerMovement({
            branchId,
            drawerSessionId,
            kind: 'PAID_OUT',
            amountMinor: 200,
            reason: 'Courier',
          }),
        NOT_IN_WORKSPACE,
      ],
      [
        'closeDrawer',
        (c) => c.closeDrawer({ branchId, drawerSessionId, countedCashMinor: 500 }),
        NOT_IN_WORKSPACE,
      ],
      ['dailyClose', (c) => c.dailyClose({ branchId, businessDate }), NOT_IN_WORKSPACE],
      ['closePreview', (c) => c.closePreview({ branchId, businessDate }), NOT_IN_WORKSPACE],
      [
        'closeDay',
        (c) =>
          c.closeDay({
            branchId,
            businessDate,
            sourceHash: 'a'.repeat(64),
            counts: [{ drawerSessionId, countedCashMinor: 500 }],
            varianceNote: 'Counted',
          }),
        NOT_IN_WORKSPACE,
      ],
      // The tender and the refund move cash through the same drawer.
      [
        'tender',
        (c) =>
          c.tender({
            branchId,
            saleId: `harden_sale_${suffix}`,
            deviceId: DEVICE,
            businessDate,
            type: 'CASH',
            amountMinor: 500,
            cashReceivedMinor: 500,
            idempotencyKey: `tender-${branchId}`,
          }),
        OUTSIDE,
      ],
      [
        'refundTender',
        (c) =>
          c.refundTender({
            branchId,
            originalTenderId: `harden_tender_${suffix}`,
            deviceId: DEVICE,
            businessDate,
            amountMinor: 500,
            reason: 'Returned medicine',
            idempotencyKey: `refund-${branchId}`,
          }),
        NOT_IN_WORKSPACE,
      ],
    ] as Array<[string, (c: Awaited<ReturnType<typeof sales>>) => Promise<unknown>, Refusal]>;

  it('refuses every drawer, close and cash procedure on a deactivated branch of the organization, writing nothing', async () => {
    const before = await rowsFor(RETIRED);
    expect(before).toEqual({ drawers: 1, movements: 1, closed: 0, closes: 0 });
    for (const [name, run, refusal] of procedures(RETIRED, retiredDrawerId)) {
      await expect(asAdmin(run), name).rejects.toMatchObject(refusal);
    }
    // The open drawer took no movement, was not closed, and no day was cut.
    expect(await rowsFor(RETIRED)).toEqual(before);
  });

  it('refuses another tenant’s branch and an unknown one the same way', async () => {
    for (const branchId of [FOREIGN, UNKNOWN]) {
      for (const [name, run, refusal] of procedures(branchId, retiredDrawerId)) {
        await expect(asAdmin(run), `${name} on ${branchId}`).rejects.toMatchObject(refusal);
      }
      expect(await rowsFor(branchId)).toEqual({ drawers: 0, movements: 0, closed: 0, closes: 0 });
    }
    // The other tenant's branch is untouched, as that tenant sees it.
    expect(await rowsFor(FOREIGN, OTHER_ORG)).toEqual({
      drawers: 0,
      movements: 0,
      closed: 0,
      closes: 0,
    });
  });

  it('serves the drawer family on an active branch of the organization', async () => {
    const drawer = await asAdmin((c) =>
      c.openDrawer({ branchId: ACTIVE, deviceId: DEVICE, businessDate, openingFloatMinor: 1000 })
    );
    await expect(
      asAdmin((c) => c.drawerStatus({ branchId: ACTIVE, deviceId: DEVICE }))
    ).resolves.toMatchObject({ openDrawer: { id: drawer!.id, openingFloatMinor: 1000 } });
    await asAdmin((c) =>
      c.drawerMovement({
        branchId: ACTIVE,
        drawerSessionId: drawer!.id,
        kind: 'PAID_IN',
        amountMinor: 250,
        reason: 'Float top-up',
      })
    );
    await expect(
      asAdmin((c) =>
        c.closeDrawer({ branchId: ACTIVE, drawerSessionId: drawer!.id, countedCashMinor: 1250 })
      )
    ).resolves.toMatchObject({ expectedCashMinor: 1250, varianceMinor: 0 });
    // The close read, like the branch list before it, carries the workspace's zone.
    await expect(
      asAdmin((c) => c.closePreview({ branchId: ACTIVE, businessDate }))
    ).resolves.toMatchObject({
      branchName: `Branch ${ACTIVE}`,
      close: null,
      timezone: 'America/Chicago',
    });
    await expect(asAdmin((c) => c.counterBranches())).resolves.toMatchObject({
      currency: 'USD',
      timezone: 'America/Chicago',
    });
    expect(await rowsFor(ACTIVE)).toEqual({ drawers: 1, movements: 3, closed: 1, closes: 0 });
  });

  it('answers the daily close’s typed refusals as typed errors, not as a 500', async () => {
    // A later business day on the active branch, with a drawer still open.
    const day = new Date('2026-10-21T00:00:00.000Z');
    const drawer = await asAdmin((c) =>
      c.openDrawer({ branchId: ACTIVE, deviceId: DEVICE, businessDate: day, openingFloatMinor: 0 })
    );
    await expect(
      asAdmin((c) => c.dailyClose({ branchId: ACTIVE, businessDate: day }))
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'OPEN_DRAWER' });
    expect(await rowsFor(ACTIVE)).toMatchObject({ closes: 0 });

    // Counted and closed, the day is cut once; cutting it again needs a reason.
    await asAdmin((c) =>
      c.closeDrawer({ branchId: ACTIVE, drawerSessionId: drawer!.id, countedCashMinor: 0 })
    );
    await expect(
      asAdmin((c) => c.dailyClose({ branchId: ACTIVE, businessDate: day }))
    ).resolves.toMatchObject({ branchId: ACTIVE, sequence: 1 });
    await expect(
      asAdmin((c) => c.dailyClose({ branchId: ACTIVE, businessDate: day }))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'REOPEN_REASON_REQUIRED' });
    expect(await rowsFor(ACTIVE)).toMatchObject({ closes: 1 });
  });

  it('hands the screens UTC for a stored zone Intl refuses, never the value itself', async () => {
    // The workspace profile saved free text before it checked the zone.
    await withPlatformDb((db) =>
      db.organization.update({ where: { id: ORG }, data: { timezone: 'PKT' } })
    );
    try {
      await expect(
        asAdmin((c) => c.closePreview({ branchId: ACTIVE, businessDate }))
      ).resolves.toMatchObject({ timezone: 'UTC' });
      await expect(asAdmin((c) => c.counterBranches())).resolves.toMatchObject({
        timezone: 'UTC',
      });
    } finally {
      await withPlatformDb((db) =>
        db.organization.update({ where: { id: ORG }, data: { timezone: 'America/Chicago' } })
      );
    }
  });
});
