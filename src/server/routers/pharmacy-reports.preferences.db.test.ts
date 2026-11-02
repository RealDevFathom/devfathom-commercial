/**
 * DEV-602 — who a pharmacy dashboard layout save can change, against PostgreSQL as
 * a NOSUPERUSER NOBYPASSRLS role. Skipped unless TEST_DATABASE_URL names that role
 * on a migrated disposable database.
 *
 * Finding pinned here: `updatePreferences` needs reports:operational, so a cashier
 * is refused before any read or write; and an allowed save writes only the
 * caller's own `users.preferences` — the role default is computed in code and has
 * no row a save could reach.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PHARMACY_WIDGET_REGISTRY,
  pharmacyDashboardDefault,
  type PharmacyDashboardPreference,
} from '@/lib/pharmacy/dashboard';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  org: `org_dash_${suffix}`,
  branch: `br_dash_${suffix}`,
  owner: `user_dash_owner_${suffix}`,
  cashier: `user_dash_cashier_${suffix}`,
  auditor: `user_dash_auditor_${suffix}`,
  freshAuditor: `user_dash_fresh_${suffix}`,
};

type Viewer = { id: string; role: 'ADMIN' | 'EMPLOYEE' };
const owner: Viewer = { id: ids.owner, role: 'ADMIN' };
const cashier: Viewer = { id: ids.cashier, role: 'EMPLOYEE' };
const auditor: Viewer = { id: ids.auditor, role: 'EMPLOYEE' };
const freshAuditor: Viewer = { id: ids.freshAuditor, role: 'EMPLOYEE' };

/** The owner's saved layout: everything hidden except trade, so any change shows. */
const OWNER_LAYOUT: PharmacyDashboardPreference = {
  version: 1,
  widgets: PHARMACY_WIDGET_REGISTRY.map((widget) => ({
    key: widget.key,
    visible: widget.key === 'trade',
    span: 'wide' as const,
  })),
};
/** What a cashier's "Save dashboard" sends: the edit-mode draft, every widget shown compact. */
const CASHIER_DRAFT: PharmacyDashboardPreference = {
  version: 1,
  widgets: [...PHARMACY_WIDGET_REGISTRY].reverse().map((widget) => ({
    key: widget.key,
    visible: true,
    span: 'compact' as const,
  })),
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacyReportsRouter: typeof import('./pharmacy-reports').pharmacyReportsRouter;
let disconnect: (() => Promise<void>) | null = null;

function act<T>(
  viewer: Viewer,
  run: (api: ReturnType<typeof pharmacyReportsRouter.createCaller>) => Promise<T>
) {
  return withTenantDb(
    ids.org,
    (db) =>
      run(
        pharmacyReportsRouter.createCaller({
          db,
          entitlements: {
            organizationId: ids.org,
            enabledModules: ['pharmacy-reports'],
            modules: [],
            limits: {},
            seatLimit: 10,
            activeSeats: 1,
          },
          session: {
            expires: 'later',
            user: {
              id: viewer.id,
              role: viewer.role,
              department: 'LEADERSHIP',
              status: 'ACTIVE',
              organizationId: ids.org,
            },
          },
          organization: { id: ids.org, vertical: 'PHARMACY' },
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as never)
      ),
    { timeout: 60_000 }
  );
}

async function storedLayouts() {
  const users = await withTenantDb(ids.org, (tx) =>
    tx.user.findMany({
      where: { id: { in: Object.values(ids).filter((id) => id.startsWith('user_')) } },
      select: { id: true, preferences: true },
    })
  );
  return Object.fromEntries(
    users.map((user) => [
      user.id,
      (user.preferences as Record<string, unknown> | null)?.pharmacyDashboard ?? null,
    ])
  );
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const reports = await import('./pharmacy-reports');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  pharmacyReportsRouter = reports.pharmacyReportsRouter;
  disconnect = () => db.$disconnect();

  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Dashboard', 'Dashboard', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.org
    )
  );
  await withTenantDb(ids.org, async (tx) => {
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    await tx.pharmacyBranch.create({
      data: {
        id: ids.branch,
        code: 'MAIN',
        name: 'Main',
        addressLine: '1 Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    // The shipped role templates, so the test follows any change to what a cashier holds.
    const roleIds: Record<string, string> = {};
    for (const template of ['owner', 'cashier', 'auditor']) {
      const capabilities = PHARMACY_ROLE_TEMPLATES.find(
        (item) => item.key === template
      )!.capabilities;
      const created = await tx.organizationRole.create({
        data: {
          key: `${template}-${suffix}`,
          name: template,
          permissions: {
            create: capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const })),
          },
        },
        select: { id: true },
      });
      roleIds[template] = created.id;
    }
    for (const person of [
      { id: ids.owner, role: 'ADMIN' as const, template: 'owner', saved: OWNER_LAYOUT },
      { id: ids.cashier, role: 'EMPLOYEE' as const, template: 'cashier', saved: null },
      { id: ids.auditor, role: 'EMPLOYEE' as const, template: 'auditor', saved: null },
      { id: ids.freshAuditor, role: 'EMPLOYEE' as const, template: 'auditor', saved: null },
    ]) {
      await tx.user.create({
        data: {
          id: person.id,
          name: person.template,
          email: `${person.id}@example.test`,
          department: 'LEADERSHIP',
          title: person.template,
          role: person.role,
          organizationRoleId: roleIds[person.template],
          ...(person.saved ? { preferences: { pharmacyDashboard: person.saved } } : {}),
        },
      });
    }
  });
});

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('pharmacy dashboard layout save authorization (DEV-602)', () => {
  it('refuses a cashier the command-centre reads and the save, changing no layout', async () => {
    const before = await storedLayouts();

    // The "Branches could not be loaded" message: the read is refused, by design.
    await expect(act(cashier, (api) => api.branches())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(act(cashier, (api) => api.getPreferences())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(act(cashier, (api) => api.updatePreferences(CASHIER_DRAFT))).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );

    expect(await storedLayouts()).toEqual(before);
    expect(before[ids.owner]).toEqual(OWNER_LAYOUT);
    expect(before[ids.cashier]).toBeNull();
  });

  it('lets a report viewer save only their own layout, never the owner’s or the role default', async () => {
    await expect(act(auditor, (api) => api.updatePreferences(CASHIER_DRAFT))).resolves.toEqual(
      CASHIER_DRAFT
    );

    const after = await storedLayouts();
    expect(after[ids.auditor]).toEqual(CASHIER_DRAFT);
    expect(after[ids.owner]).toEqual(OWNER_LAYOUT);
    expect(after[ids.cashier]).toBeNull();
    expect(after[ids.freshAuditor]).toBeNull();

    // The owner still reads their own layout; another viewer of the same role still
    // reads the code-defined role default, untouched by the save.
    await expect(act(owner, (api) => api.getPreferences())).resolves.toEqual(OWNER_LAYOUT);
    await expect(act(freshAuditor, (api) => api.getPreferences())).resolves.toEqual(
      pharmacyDashboardDefault('EMPLOYEE')
    );
  });

  it('cannot be aimed at another member: the input names no user', async () => {
    await expect(
      act(auditor, (api) => api.updatePreferences({ ...CASHIER_DRAFT, userId: ids.owner } as never))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await storedLayouts())[ids.owner]).toEqual(OWNER_LAYOUT);
  });
});
