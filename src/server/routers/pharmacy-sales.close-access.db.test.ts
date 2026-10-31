/**
 * @vitest-environment node
 *
 * A close grant must not expand a shift lead's branch assignments. Run against
 * a migrated disposable TEST_DATABASE_URL as NOSUPERUSER NOBYPASSRLS.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let salesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
const prefix = `close_access_${randomUUID().replaceAll('-', '')}`;
const org = `${prefix}_org`;
const other = `${prefix}_other`;
const actor = `${prefix}_lead`;
const assigned = `${prefix}_assigned`;
const sibling = `${prefix}_sibling`;
const retired = `${prefix}_retired`;
const foreign = `${prefix}_foreign`;
const businessDate = new Date('2026-10-25T00:00:00Z');

function caller(db: ScopedDb, role: 'ADMIN' | 'EMPLOYEE' = 'EMPLOYEE') {
  return salesRouter.createCaller({
    db,
    entitlements: { organizationId: org, enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: actor, role, status: 'ACTIVE', organizationId: org },
    },
    organization: { id: org, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}
function request<T>(
  run: (c: ReturnType<typeof caller>) => Promise<T>,
  role: 'ADMIN' | 'EMPLOYEE' = 'EMPLOYEE'
) {
  return withTenantDb(org, (db) => run(caller(db, role)), { userId: actor });
}

(databaseUrl ? describe : describe.skip)(
  'pharmacy close branch authorization on PostgreSQL',
  () => {
    beforeAll(async () => {
      ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
      ({ pharmacySalesRouter: salesRouter } = await import('./pharmacy-sales'));
      const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
      await assertRlsEnforcingRole(withPlatformDb);
      await withPlatformDb(async (db) => {
        for (const id of [org, other]) {
          await db.organization.create({
            data: {
              id,
              slug: id,
              legalName: id,
              displayName: id,
              vertical: 'PHARMACY',
              status: 'ACTIVE',
            },
          });
        }
      });
      await withTenantDb(org, async (db) => {
        await db.organizationDepartment.create({
          data: { organizationId: org, key: 'Pharmacy', name: 'Pharmacy' },
        });
        const role = await db.organizationRole.create({
          data: { organizationId: org, key: 'shift-lead', name: 'Shift lead' },
        });
        await db.organizationRolePermission.create({
          data: {
            organizationId: org,
            organizationRoleId: role.id,
            capability: 'pharmacy:close',
            effect: 'ALLOW',
          },
        });
        await db.user.create({
          data: {
            id: actor,
            organizationId: org,
            organizationRoleId: role.id,
            name: 'Shift lead',
            email: `${actor}@example.invalid`,
            department: 'Pharmacy',
            title: 'Shift lead',
            role: 'EMPLOYEE',
            status: 'ACTIVE',
          },
        });
        for (const id of [assigned, sibling, retired]) {
          await db.pharmacyBranch.create({
            data: {
              id,
              organizationId: org,
              code: id,
              name: id,
              addressLine: 'Test',
              city: 'Test',
              provinceCode: 'PB',
            },
          });
        }
        await db.pharmacyBranchAssignment.createMany({
          data: [assigned, retired].map((branchId) => ({
            organizationId: org,
            branchId,
            userId: actor,
            active: true,
          })),
        });
        await db.pharmacyBranch.update({ where: { id: retired }, data: { active: false } });
      });
      await withTenantDb(other, (db) =>
        db.pharmacyBranch.create({
          data: {
            id: foreign,
            organizationId: other,
            code: foreign,
            name: foreign,
            addressLine: 'Test',
            city: 'Test',
            provinceCode: 'PB',
          },
        })
      );
    }, 120_000);

    it('lists only assigned active branches for a shift lead and every active branch for an admin', async () => {
      const lead = await request((c) => c.counterBranches({ forDayClose: true }));
      expect(lead.branches.map((b) => b.id)).toEqual([assigned]);
      const admin = await request((c) => c.counterBranches({ forDayClose: true }), 'ADMIN');
      expect(admin.branches.map((b) => b.id).sort()).toEqual([assigned, sibling].sort());
    });

    it('refuses preview and both closes on an unassigned branch, preserving its open drawer', async () => {
      const drawer = await request(
        (c) =>
          c.openDrawer({
            branchId: sibling,
            deviceId: 'sibling-counter',
            businessDate,
            openingFloatMinor: 500,
          }),
        'ADMIN'
      );
      const preview = await request(
        (c) => c.closePreview({ branchId: sibling, businessDate }),
        'ADMIN'
      );
      const denied = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };
      await expect(
        request((c) => c.closePreview({ branchId: sibling, businessDate }))
      ).rejects.toMatchObject(denied);
      await expect(
        request((c) =>
          c.closeDay({
            branchId: sibling,
            businessDate,
            sourceHash: preview.totals.sourceHash,
            counts: [{ drawerSessionId: drawer!.id, countedCashMinor: 500 }],
            varianceNote: '',
          })
        )
      ).rejects.toMatchObject(denied);
      await expect(
        request((c) => c.dailyClose({ branchId: sibling, businessDate }))
      ).rejects.toMatchObject(denied);
      await withTenantDb(org, async (db) => {
        expect(await db.pharmacyDailyClose.count({ where: { branchId: sibling } })).toBe(0);
        expect(
          await db.pharmacyDrawerSession.findUnique({ where: { id: drawer!.id } })
        ).toMatchObject({ status: 'OPEN' });
        expect(
          await db.pharmacyDrawerMovement.count({ where: { drawerSessionId: drawer!.id } })
        ).toBe(1);
      });
    });

    it('lets an assigned shift lead reconcile and close, including the legacy daily close', async () => {
      const drawer = await request((c) =>
        c.openDrawer({
          branchId: assigned,
          deviceId: 'assigned-counter',
          businessDate,
          openingFloatMinor: 500,
        })
      );
      const preview = await request((c) => c.closePreview({ branchId: assigned, businessDate }));
      await expect(
        request((c) =>
          c.closeDay({
            branchId: assigned,
            businessDate,
            sourceHash: preview.totals.sourceHash,
            counts: [{ drawerSessionId: drawer!.id, countedCashMinor: 500 }],
            varianceNote: '',
          })
        )
      ).resolves.toMatchObject({ branchId: assigned, actorId: actor });
      await expect(
        request((c) =>
          c.dailyClose({
            branchId: assigned,
            businessDate: new Date('2026-10-26T00:00:00Z'),
          })
        )
      ).resolves.toMatchObject({ branchId: assigned, actorId: actor });
    });

    it('denies foreign and inactive branches', async () => {
      for (const branchId of [foreign, retired]) {
        await expect(
          request((c) => c.closePreview({ branchId, businessDate }))
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
    });

    it('revoking an assignment empties the picker and denies all three close operations', async () => {
      await withTenantDb(org, (db) =>
        db.pharmacyBranchAssignment.updateMany({
          where: { organizationId: org, userId: actor, branchId: assigned },
          data: { active: false },
        })
      );
      await expect(request((c) => c.counterBranches({ forDayClose: true }))).resolves.toMatchObject(
        { branches: [] }
      );
      await expect(
        request((c) => c.closePreview({ branchId: assigned, businessDate }))
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        request((c) => c.dailyClose({ branchId: assigned, businessDate }))
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        request((c) =>
          c.closeDay({
            branchId: assigned,
            businessDate,
            sourceHash: 'a'.repeat(64),
            counts: [],
            varianceNote: '',
          })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Organization administrators retain their existing unassigned access.
      await expect(
        request((c) => c.closePreview({ branchId: assigned, businessDate }), 'ADMIN')
      ).resolves.toMatchObject({ branchName: assigned });
    });
  }
);
