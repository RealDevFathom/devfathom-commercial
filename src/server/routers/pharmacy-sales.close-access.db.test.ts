/**
 * @vitest-environment node
 *
 * DEV-739: the day-close journey against a REAL migrated PostgreSQL, through the real
 * router, each call in its own tenant transaction the way each HTTP request runs.
 *
 * The day-close screen and the rail ask `dayCloseAccess` which branches this user may
 * close, then the screen previews and closes one of them. For each kind
 * of user the branches `dayCloseAccess` names must be exactly the ones the preview and
 * the close admit: an assigned manager closes their branch and nothing else, an
 * administrator closes any active branch of the organization, and a default
 * pharmacist, a manager under an explicit DENY or a manager whose assignment was
 * withdrawn is offered nothing and refused everything.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first).
 * Without it the suite reports itself skipped rather than passing vacuously. Only the
 * web identity boundary and the audit row write are stubbed.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

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
const ORG = `close_access_a_${suffix}`;
const OTHER_ORG = `close_access_b_${suffix}`;
const MAIN = `close_access_main_${suffix}`;
const AIRPORT = `close_access_airport_${suffix}`;
const FOREIGN = `close_access_foreign_${suffix}`;
const ADMIN = `close_access_admin_${suffix}`;
/** An administrator on the bootstrap system Administrator role (key `administrator`). */
const BOOTSTRAP_ADMIN = `close_access_bootstrap_admin_${suffix}`;
const MANAGER = `close_access_manager_${suffix}`;
const PHARMACIST = `close_access_pharmacist_${suffix}`;
const DENIED_MANAGER = `close_access_denied_${suffix}`;
const businessDate = new Date('2026-10-20T00:00:00.000Z');

const NO_CLOSE = {
  code: 'FORBIDDEN',
  message: 'Day-close permission is required to reconcile and close a day.',
};
const OUTSIDE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };
const NOT_IN_WORKSPACE = { code: 'BAD_REQUEST', message: 'That record is not in this workspace.' };

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];

async function sales(db: ScopedDb, userId: string, role: string) {
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
      user: { id: userId, role, status: 'ACTIVE', organizationId: ORG },
    },
    organization: { id: ORG, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

/** One request by `userId`, in ORG's tenant transaction. */
function as<T>(
  userId: string,
  role: string,
  run: (caller: Awaited<ReturnType<typeof sales>>) => Promise<T>
): Promise<T> {
  return withTenantDb(ORG, async (db) => run(await sales(db, userId, role)), { userId });
}

async function closesFor(branchId: string) {
  const [row] = await withTenantDb(ORG, (db) =>
    db.$queryRawUnsafe<Array<{ closes: bigint }>>(
      `SELECT count(*) AS closes FROM pharmacy_daily_closes WHERE "branchId" = $1`,
      branchId
    )
  );
  return Number(row!.closes);
}

/** The screen's journey: ask, preview what was offered, close it. */
async function closeOfferedBranch(userId: string, role: string, branchId: string) {
  const preview = await as(userId, role, (c) => c.closePreview({ branchId, businessDate }));
  expect(preview!.drawers).toEqual([]);
  return as(userId, role, (c) =>
    c.closeDay({
      branchId,
      businessDate,
      sourceHash: preview!.totals.sourceHash,
      counts: [],
      varianceNote: '',
    })
  );
}

describeIfDatabase('day-close access journey, against PostgreSQL (DEV-739)', () => {
  beforeAll(async () => {
    const scoped = await import('@/lib/tenancy/scoped-db');
    withTenantDb = scoped.withTenantDb;
    withPlatformDb = scoped.withPlatformDb;
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(withPlatformDb);
    await withPlatformDb(async (db) => {
      await db.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id`,
        [ORG, OTHER_ORG]
      );
      await db.$executeRawUnsafe(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt") VALUES ($1, $2, 'Pharmacy', 'Pharmacy', now())`,
        `${ORG}_department`,
        ORG
      );
    });
    // The shipped Manager and Pharmacist templates, as a tenant's roles.
    const roleIds: Record<string, string> = {};
    await withTenantDb(ORG, async (db) => {
      for (const key of ['manager', 'pharmacist']) {
        const template = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!;
        // The shipped system roles: day close follows the assigned system role (DEV-739).
        const role = await db.organizationRole.create({
          data: {
            organizationId: ORG,
            key,
            name: template.name,
            isSystem: true,
            permissions: {
              create: template.capabilities.map((capability) => ({
                organizationId: ORG,
                capability,
                effect: 'ALLOW' as const,
              })),
            },
          },
        });
        roleIds[key] = role.id;
      }
      // Workspaces created before the canonical templates carry this bootstrap role.
      const bootstrap = await db.organizationRole.create({
        data: { organizationId: ORG, key: 'administrator', name: 'Administrator', isSystem: true },
      });
      roleIds.administrator = bootstrap.id;
    });
    await withPlatformDb(async (db) => {
      for (const [id, role, organizationRoleId] of [
        [ADMIN, 'ADMIN', null],
        [BOOTSTRAP_ADMIN, 'ADMIN', roleIds.administrator],
        [MANAGER, 'EMPLOYEE', roleIds.manager],
        [PHARMACIST, 'EMPLOYEE', roleIds.pharmacist],
        [DENIED_MANAGER, 'EMPLOYEE', roleIds.manager],
      ] as const)
        await db.$executeRawUnsafe(
          `INSERT INTO users (id, "organizationId", name, email, role, department, title, "organizationRoleId", "updatedAt") VALUES ($1, $2, $1, $3, $4::"Role", 'Pharmacy', 'Staff', $5, now())`,
          id,
          ORG,
          `${id}@example.test`,
          role,
          organizationRoleId
        );
    });
    for (const [organizationId, id, name] of [
      [ORG, MAIN, 'Main'],
      [ORG, AIRPORT, 'Airport'],
      [OTHER_ORG, FOREIGN, 'Elsewhere'],
    ] as const)
      await withTenantDb(organizationId, (db) =>
        db.pharmacyBranch.create({
          data: {
            id,
            organizationId,
            code: id,
            name,
            addressLine: '1 Synthetic Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        })
      );
    await withTenantDb(ORG, async (db) => {
      for (const userId of [MANAGER, PHARMACIST, DENIED_MANAGER])
        await db.pharmacyBranchAssignment.create({
          data: { organizationId: ORG, branchId: MAIN, userId },
        });
      await db.userPermissionOverride.create({
        data: {
          organizationId: ORG,
          userId: DENIED_MANAGER,
          capability: 'pharmacy:close',
          effect: 'DENY',
          reason: 'Not closing this quarter',
        },
      });
    });
  }, 120_000);

  it('offers an assigned manager their branch only, and the close admits exactly that', async () => {
    await expect(as(MANAGER, 'EMPLOYEE', (c) => c.dayCloseAccess())).resolves.toEqual({
      userId: MANAGER,
      organizationId: ORG,
      allowed: true,
      branchIds: [MAIN],
    });
    const closed = await closeOfferedBranch(MANAGER, 'EMPLOYEE', MAIN);
    expect(closed).toMatchObject({ sequence: 1, isFinal: true });
    expect(await closesFor(MAIN)).toBe(1);
    // The branch it was not offered: refused by preview and close, nothing written.
    await expect(
      as(MANAGER, 'EMPLOYEE', (c) => c.closePreview({ branchId: AIRPORT, businessDate }))
    ).rejects.toMatchObject(OUTSIDE);
    await expect(
      as(MANAGER, 'EMPLOYEE', (c) =>
        c.closeDay({
          branchId: AIRPORT,
          businessDate,
          sourceHash: 'a'.repeat(64),
          counts: [],
          varianceNote: '',
        })
      )
    ).rejects.toMatchObject(OUTSIDE);
    expect(await closesFor(AIRPORT)).toBe(0);
    await expect(
      as(MANAGER, 'EMPLOYEE', (c) => c.closePreview({ branchId: FOREIGN, businessDate }))
    ).rejects.toMatchObject(NOT_IN_WORKSPACE);
  });

  it('offers the administrator every active branch of the organization, and the close admits them', async () => {
    const access = await as(ADMIN, 'ADMIN', (c) => c.dayCloseAccess());
    expect(access).toEqual({
      userId: ADMIN,
      organizationId: ORG,
      allowed: true,
      branchIds: [AIRPORT, MAIN],
    });
    await expect(closeOfferedBranch(ADMIN, 'ADMIN', AIRPORT)).resolves.toMatchObject({
      sequence: 1,
    });
    expect(await closesFor(AIRPORT)).toBe(1);
    await expect(
      as(ADMIN, 'ADMIN', (c) => c.closePreview({ branchId: FOREIGN, businessDate }))
    ).rejects.toMatchObject(NOT_IN_WORKSPACE);
  });

  it('offers an administrator on the bootstrap Administrator role every branch, and the close admits it', async () => {
    await expect(as(BOOTSTRAP_ADMIN, 'ADMIN', (c) => c.dayCloseAccess())).resolves.toEqual({
      userId: BOOTSTRAP_ADMIN,
      organizationId: ORG,
      allowed: true,
      branchIds: [AIRPORT, MAIN],
    });
    const preview = await as(BOOTSTRAP_ADMIN, 'ADMIN', (c) =>
      c.closePreview({ branchId: MAIN, businessDate: new Date('2026-10-22T00:00:00.000Z') })
    );
    expect(preview!.drawers).toEqual([]);
  });

  it.each([
    ['a default pharmacist assigned to the branch', PHARMACIST],
    ['an assigned manager under an explicit pharmacy:close DENY', DENIED_MANAGER],
  ])('offers %s nothing, and the preview and close refuse', async (_label, userId) => {
    await expect(as(userId, 'EMPLOYEE', (c) => c.dayCloseAccess())).resolves.toEqual({
      userId,
      organizationId: ORG,
      allowed: false,
      branchIds: [],
    });
    await expect(
      as(userId, 'EMPLOYEE', (c) => c.closePreview({ branchId: MAIN, businessDate }))
    ).rejects.toMatchObject(NO_CLOSE);
    await expect(
      as(userId, 'EMPLOYEE', (c) =>
        c.closeDay({
          branchId: MAIN,
          businessDate: new Date('2026-10-21T00:00:00.000Z'),
          sourceHash: 'a'.repeat(64),
          counts: [],
          varianceNote: '',
        })
      )
    ).rejects.toMatchObject(NO_CLOSE);
  });

  it('withdraws the offer and the close together when the manager’s assignment ends', async () => {
    const setAssignment = (active: boolean) =>
      withTenantDb(ORG, (db) =>
        db.pharmacyBranchAssignment.updateMany({
          where: { organizationId: ORG, userId: MANAGER, branchId: MAIN },
          data: { active },
        })
      );
    await setAssignment(false);
    try {
      await expect(as(MANAGER, 'EMPLOYEE', (c) => c.dayCloseAccess())).resolves.toMatchObject({
        allowed: false,
        branchIds: [],
      });
      await expect(
        as(MANAGER, 'EMPLOYEE', (c) => c.closePreview({ branchId: MAIN, businessDate }))
      ).rejects.toMatchObject(OUTSIDE);
    } finally {
      await setAssignment(true);
    }
  });

  it('withdraws both when the administrator is demoted to the Pharmacist role in the database', async () => {
    const pharmacistRole = await withTenantDb(ORG, (db) =>
      db.organizationRole.findFirstOrThrow({
        where: { organizationId: ORG, key: 'pharmacist' },
        select: { id: true },
      })
    );
    await withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `UPDATE users SET role = 'EMPLOYEE', "organizationRoleId" = $2 WHERE id = $1`,
        ADMIN,
        pharmacistRole.id
      )
    );
    try {
      // The session still says ADMIN; the stored row decides.
      await expect(as(ADMIN, 'ADMIN', (c) => c.dayCloseAccess())).resolves.toMatchObject({
        allowed: false,
        branchIds: [],
      });
      await expect(
        as(ADMIN, 'ADMIN', (c) => c.closePreview({ branchId: MAIN, businessDate }))
      ).rejects.toMatchObject(NO_CLOSE);
    } finally {
      await withPlatformDb((db) =>
        db.$executeRawUnsafe(
          `UPDATE users SET role = 'ADMIN', "organizationRoleId" = NULL WHERE id = $1`,
          ADMIN
        )
      );
    }
  });
});
