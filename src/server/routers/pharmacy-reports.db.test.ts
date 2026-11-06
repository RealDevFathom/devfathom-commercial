/** PV boundary and solo-owner approval against PostgreSQL. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  PHARMACY_BOOTSTRAP_ADMIN_EXACT_GRANTS,
  PHARMACY_ROLE_TEMPLATES,
} from '@/lib/vertical-catalog';
import type { TRPCContext } from '../trpc';

// The successful solo audit is real and transactional. Suppress only the normal
// asynchronous request audit so rollback-only fixtures never leak pending writes.
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const suite = databaseUrl ? describe : describe.skip;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let router: typeof import('./pharmacy-reports').pharmacyReportsRouter;
let hashPin: typeof import('@/lib/restaurant/operator-credentials').hashOperatorCredential;
let seedDepartments: typeof import('@/lib/test-support/departments').seedDepartments;
let pinHash: string;
let testRole: string | null = null;
const rollback = new Error('rollback-only security fixture');

beforeAll(async () => {
  ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
  ({ pharmacyReportsRouter: router } = await import('./pharmacy-reports'));
  ({ hashOperatorCredential: hashPin } = await import('@/lib/restaurant/operator-credentials'));
  ({ seedDepartments } = await import('@/lib/test-support/departments'));
  pinHash = await hashPin('PIN', '1234');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const [role] = (
      await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')
    ).rows;
    if (role.rolsuper || role.rolbypassrls) {
      testRole = `pv_qa_${randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE ROLE "${testRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await client.query(`GRANT USAGE ON SCHEMA public TO "${testRole}"`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${testRole}"`
      );
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${testRole}"`);
    }
  } finally {
    await client.end();
  }
}, 60_000);

afterAll(async () => {
  if (!testRole) return;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP OWNED BY "${testRole}"`);
    await client.query(`DROP ROLE "${testRole}"`);
  } finally {
    await client.end();
  }
});

async function fixture(
  run: (f: {
    db: ScopedDb;
    org: string;
    owner: string;
    branch: string;
    api: (
      userId: string,
      role?: 'ADMIN' | 'EMPLOYEE',
      licensed?: boolean
    ) => ReturnType<typeof router.createCaller>;
  }) => Promise<void>
) {
  const org = `pv_security_${randomUUID().replaceAll('-', '')}`;
  const owner = `${org}_owner`;
  const branch = `${org}_branch`;
  try {
    await withTenantDb(
      org,
      async (db) => {
        await db.organization.create({
          data: {
            id: org,
            slug: org,
            legalName: org,
            displayName: org,
            vertical: 'PHARMACY',
            status: 'ACTIVE',
          },
        });
        await seedDepartments(db, [org], ['LEADERSHIP']);
        // Tenant ADMIN alone is insufficient: pharmacy:safety is exact-grant-only.
        const ownerRole = await db.organizationRole.create({
          data: {
            key: 'owner-operator',
            name: 'Owner / Operator',
            permissions: { create: [{ capability: 'pharmacy:safety', effect: 'ALLOW' }] },
          },
        });
        await db.user.create({
          data: {
            id: owner,
            name: 'Owner',
            email: `${owner}@example.test`,
            role: 'ADMIN',
            department: 'LEADERSHIP',
            title: 'Owner',
            organizationRoleId: ownerRole.id,
          },
        });
        await db.pharmacyBranch.create({
          data: {
            id: branch,
            code: 'MAIN',
            name: 'Main',
            addressLine: 'Test',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
        await db.pharmacyBranchAssignment.create({ data: { branchId: branch, userId: owner } });
        const profile = await db.restaurantStaffProfile.create({
          data: { userId: owner, displayName: 'Owner' },
        });
        await db.restaurantOperatorCredential.create({
          data: { staffProfileId: profile.id, type: 'PIN', credentialHash: pinHash },
        });
        await db.$queryRaw`SELECT set_config('app.current_branch_id', ${branch}, true)`;
        if (testRole) await db.$executeRawUnsafe(`SET LOCAL ROLE "${testRole}"`);
        const [runtime] = await db.$queryRaw<
          Array<{ rolsuper: boolean; rolbypassrls: boolean }>
        >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
        expect(runtime).toEqual({ rolsuper: false, rolbypassrls: false });
        const context = (userId: string, role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN', licensed = true) =>
          ({
            db,
            entitlements: {
              organizationId: org,
              enabledModules: licensed ? ['pharmacy-reports'] : [],
              modules: [],
              limits: {},
              activeSeats: 1,
              seatLimit: 10,
            },
            session: {
              expires: 'later',
              user: { id: userId, role, status: 'ACTIVE', organizationId: org },
            },
            organization: { id: org, vertical: 'PHARMACY' },
            support: null,
            requestMeta: { ip: null, userAgent: null },
            audit: { detail: {} },
          }) as unknown as TRPCContext;
        const api = (userId: string, role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN', licensed = true) =>
          router.createCaller(context(userId, role, licensed));
        await run({ db, org, owner, branch, api });
        throw rollback;
      },
      { timeout: 60_000, skipDrain: true }
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function reviewable(db: ScopedDb, branchId: string, creator: string) {
  return db.pharmacyPharmacovigilanceReport.create({
    data: {
      branchId,
      createdByUserId: creator,
      kind: 'ADVERSE_DRUG_REACTION',
      occurredAt: new Date(),
      assertedDescription: 'Human asserted report',
      state: 'UNDER_REVIEW',
    },
  });
}

suite('PV security persistence and compatibility', () => {
  it('denies a tenant ADMIN without an exact pharmacy:safety grant', async () => {
    await fixture(async ({ db, org, branch, api }) => {
      const admin = await db.user.create({
        data: {
          name: 'Admin',
          email: `${org}_admin@example.test`,
          role: 'ADMIN',
          department: 'LEADERSHIP',
          title: 'Admin',
        },
      });
      await db.pharmacyBranchAssignment.create({ data: { branchId: branch, userId: admin.id } });
      const dates = { from: new Date('2020-01-01'), to: new Date('2099-01-01') };
      await expect(
        api(admin.id).exportPharmacovigilanceDrap({ branchId: branch, ...dates })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  it.each([
    [
      'default Owner template',
      'owner',
      PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'owner')!.capabilities,
    ],
    ['bootstrap Admin role', 'admin', ['*', ...PHARMACY_BOOTSTRAP_ADMIN_EXACT_GRANTS]],
  ])(
    'lets a solo pharmacy on the %s file a report and move it to READY',
    async (_label, key, capabilities) => {
      await fixture(async ({ db, owner, branch, api }) => {
        // Exactly what provisioning (and the #479 backfill) gives this role: no
        // hand-added test grant beyond the shipped template.
        const role = await db.organizationRole.create({
          data: {
            key,
            name: key,
            isSystem: true,
            permissions: {
              create: capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const })),
            },
          },
        });
        await db.user.update({ where: { id: owner }, data: { organizationRoleId: role.id } });
        const filed = await api(owner).createPharmacovigilanceReport({
          branchId: branch,
          kind: 'ADVERSE_DRUG_REACTION',
          occurredAt: new Date(),
          assertedDescription: 'Patient reported a rash after the first dose.',
        });
        expect(filed).toMatchObject({ state: 'DRAFT', createdByUserId: owner });
        await api(owner).transitionPharmacovigilanceReport({
          id: filed.id,
          branchId: branch,
          state: 'UNDER_REVIEW',
        });
        await api(owner).transitionPharmacovigilanceReport({
          id: filed.id,
          branchId: branch,
          state: 'READY',
          pin: '1234',
        });
        expect(
          await db.pharmacyPharmacovigilanceReport.findUniqueOrThrow({ where: { id: filed.id } })
        ).toMatchObject({ state: 'READY', reviewedByUserId: owner });
        expect(
          await db.auditLog.count({
            where: { action: 'pv_solo_owner_approval', targetId: filed.id },
          })
        ).toBe(1);
      });
    }
  );

  it('requires PIN for solo readiness and commits a matching audit without changing external submission state', async () => {
    await fixture(async ({ db, owner, branch, api }) => {
      const report = await reviewable(db, branch, owner);
      const input = { id: report.id, branchId: branch, state: 'READY' as const };
      await expect(api(owner).transitionPharmacovigilanceReport(input)).resolves.toHaveProperty(
        'blocked'
      );
      expect(
        (await db.pharmacyPharmacovigilanceReport.findUniqueOrThrow({ where: { id: report.id } }))
          .state
      ).toBe('UNDER_REVIEW');
      await api(owner).transitionPharmacovigilanceReport({ ...input, pin: '1234' });
      expect(
        await db.pharmacyPharmacovigilanceReport.findUniqueOrThrow({ where: { id: report.id } })
      ).toMatchObject({
        state: 'READY',
        externalSubmissionState: 'NOT_SUBMITTED',
        reviewedByUserId: owner,
      });
      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: 'pv_solo_owner_approval', targetId: report.id },
      });
      expect(audit).toMatchObject({
        actorId: owner,
        input: '[skipped]',
        metadata: {
          policy: 'PV:SOLO_OWNER_PIN',
          branchId: branch,
          reauthenticatedAt: expect.any(String),
        },
      });
      expect(JSON.stringify(audit)).not.toContain('1234');
    });
  });

  it('persists five failed PIN attempts as a lockout and rejects the correct PIN while locked', async () => {
    await fixture(async ({ db, owner, branch, api }) => {
      const report = await reviewable(db, branch, owner);
      const input = { id: report.id, branchId: branch, state: 'READY' as const, pin: '0000' };
      for (let attempt = 0; attempt < 5; attempt++)
        await expect(api(owner).transitionPharmacovigilanceReport(input)).resolves.toHaveProperty(
          'blocked'
        );
      expect(await db.restaurantOperatorCredential.findFirstOrThrow()).toMatchObject({
        failedAttempts: 0,
        lockedUntil: expect.any(Date),
      });
      await expect(
        api(owner).transitionPharmacovigilanceReport({ ...input, pin: '1234' })
      ).resolves.toHaveProperty('blocked');
      expect(
        (await db.pharmacyPharmacovigilanceReport.findUniqueOrThrow({ where: { id: report.id } }))
          .state
      ).toBe('UNDER_REVIEW');
      expect(await db.auditLog.count({ where: { action: 'pv_solo_owner_approval' } })).toBe(0);
    });
  });

  it('blocks staffed owner self approval but allows an assigned safety reviewer without reports capability', async () => {
    await fixture(async ({ db, owner, branch, api }) => {
      const role = await db.organizationRole.create({
        data: {
          key: 'safety',
          name: 'Safety',
          permissions: { create: [{ capability: 'pharmacy:safety', effect: 'ALLOW' }] },
        },
      });
      const reviewer = await db.user.create({
        data: {
          name: 'Reviewer',
          email: `${owner}_review@example.test`,
          department: 'LEADERSHIP',
          title: 'Reviewer',
          organizationRoleId: role.id,
        },
      });
      await db.pharmacyBranchAssignment.create({ data: { branchId: branch, userId: reviewer.id } });
      const report = await reviewable(db, branch, owner);
      const input = { id: report.id, branchId: branch, state: 'READY' as const };
      await expect(
        api(owner).transitionPharmacovigilanceReport({ ...input, pin: '1234' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await api(reviewer.id, 'EMPLOYEE').transitionPharmacovigilanceReport(input);
      expect(
        (await db.pharmacyPharmacovigilanceReport.findUniqueOrThrow({ where: { id: report.id } }))
          .reviewedByUserId
      ).toBe(reviewer.id);
      const sibling = await db.pharmacyBranch.create({
        data: {
          code: 'SIBLING',
          name: 'Sibling',
          addressLine: 'Test',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      const dates = { from: new Date('2020-01-01'), to: new Date('2099-01-01') };
      await expect(
        api(reviewer.id, 'EMPLOYEE').exportPharmacovigilanceDrap({ branchId: sibling.id, ...dates })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api(owner, 'ADMIN', false).exportPharmacovigilanceDrap({ branchId: branch, ...dates })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(
        (await api(owner).exportPharmacovigilanceDrap({ branchId: branch, ...dates })).reports
      ).toHaveLength(1);
    });
  });
});
