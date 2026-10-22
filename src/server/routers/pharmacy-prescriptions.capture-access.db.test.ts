/**
 * #238 — prescription capture access against PostgreSQL as a NOSUPERUSER NOBYPASSRLS role.
 *
 * ABAC reads the PERSISTED organization role and user overrides, not the templates in
 * vertical-catalog, so this suite stores roles the way provisioning and the #163 migration leave
 * them and asks the real router. `captureAccess` (what the counter and the prescriptions page
 * use to decide whether to offer capture) must agree with the upload guard for every one:
 *
 * - a cashier, whether it holds counter only (migrated) or counter + orders (template), or even
 *   a wildcard, is refused: captureAccess says no and uploadSource is a 403, never a 500;
 * - a pharmacist and an owner/administrator holding the exact pharmacy:dispense grant may;
 * - a tenant ADMIN without that grant, and any explicit DENY, are refused.
 *
 * An allowed upload stops at the synthetic patient (NOT_FOUND), so storage is never written.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const org = `org_r238_${suffix}`;
const id = (key: string) => `r238_${key}_${suffix}`;
/** 1x1 PNG. The guard runs before input validation, so its content only matters when allowed. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const template = (key: string) =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities;

type Person = {
  key: string;
  role: 'ADMIN' | 'EMPLOYEE';
  capabilities: readonly string[] | null;
  overrides?: Array<{ capability: string; effect: 'ALLOW' | 'DENY' }>;
  allowed: boolean;
};
const people: Person[] = [
  // #163 maps a legacy pharmacy.counter grant to pharmacy:counter only.
  { key: 'cashier_migrated', role: 'EMPLOYEE', capabilities: ['pharmacy:counter'], allowed: false },
  { key: 'cashier_template', role: 'EMPLOYEE', capabilities: template('cashier'), allowed: false },
  {
    key: 'cashier_wildcard',
    role: 'EMPLOYEE',
    capabilities: template('cashier'),
    overrides: [{ capability: 'pharmacy:*', effect: 'ALLOW' }],
    allowed: false,
  },
  { key: 'pharmacist', role: 'EMPLOYEE', capabilities: template('pharmacist'), allowed: true },
  // The Owner template's pharmacy:* never confers an exact-grant-only action.
  { key: 'owner_wildcard', role: 'EMPLOYEE', capabilities: template('owner'), allowed: false },
  {
    key: 'owner_operator',
    role: 'ADMIN',
    capabilities: template('owner-operator'),
    allowed: true,
  },
  { key: 'admin_no_grant', role: 'ADMIN', capabilities: null, allowed: false },
  {
    key: 'admin_granted',
    role: 'ADMIN',
    capabilities: null,
    overrides: [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
    allowed: true,
  },
  {
    key: 'admin_denied',
    role: 'ADMIN',
    capabilities: template('owner-operator'),
    overrides: [{ capability: 'pharmacy:dispense', effect: 'DENY' }],
    allowed: false,
  },
];

type PrescriptionsCaller = {
  captureAccess: () => Promise<{ allowed: boolean }>;
  workspace: () => Promise<unknown>;
  uploadSource: (input: {
    patientId: string;
    contentType: 'image/png';
    dataBase64: string;
  }) => Promise<unknown>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let router: typeof import('./pharmacy-prescriptions').pharmacyPrescriptionsRouter;
let disconnect: (() => Promise<void>) | null = null;

function act<T>(person: Person, run: (api: PrescriptionsCaller) => Promise<T>) {
  return withTenantDb(
    org,
    (db) =>
      run(
        router.createCaller({
          db,
          entitlements: {
            organizationId: org,
            enabledModules: ['pharmacy-counter', 'pharmacy-dispensing'],
            modules: [],
            limits: {},
            seatLimit: 10,
            activeSeats: 1,
          },
          session: {
            expires: 'later',
            user: {
              id: id(person.key),
              role: person.role,
              department: 'LEADERSHIP',
              status: 'ACTIVE',
              organizationId: org,
            },
          },
          organization: { id: org, vertical: 'PHARMACY' },
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as never) as PrescriptionsCaller
      ),
    { timeout: 60_000, userId: id(person.key) }
  );
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const prescriptions = await import('./pharmacy-prescriptions');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  router = prescriptions.pharmacyPrescriptionsRouter;
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
       VALUES ($1, $1, 'Capture', 'Capture', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      org
    )
  );
  await withTenantDb(org, async (tx) => {
    await seedDepartments(tx, [org], ['LEADERSHIP']);
    for (const person of people) {
      if (person.capabilities) {
        await tx.organizationRole.create({
          data: {
            id: id(`role_${person.key}`),
            key: id(`role_${person.key}`),
            name: person.key,
            permissions: {
              create: person.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
            },
          },
        });
      }
      await tx.user.create({
        data: {
          id: id(person.key),
          name: person.key,
          email: `${id(person.key)}@example.test`,
          department: 'LEADERSHIP',
          title: person.key,
          role: person.role,
          organizationRoleId: person.capabilities ? id(`role_${person.key}`) : null,
        },
      });
      for (const override of person.overrides ?? []) {
        await tx.userPermissionOverride.create({
          data: { userId: id(person.key), ...override, reason: 'Synthetic test grant' },
        });
      }
    }
  });
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('prescription capture access from persisted roles (#238)', () => {
  it.each(people)('$key: captureAccess and the upload guard agree', async (person) => {
    await expect(act(person, (api) => api.captureAccess())).resolves.toEqual({
      allowed: person.allowed,
    });
    const upload = act(person, (api) =>
      api.uploadSource({ patientId: id('no_patient'), contentType: 'image/png', dataBase64: PNG })
    );
    if (person.allowed) {
      // Past the guard; the synthetic patient stops it before any file is stored.
      await expect(upload).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } else {
      await expect(upload).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Prescription file access is not permitted.',
      });
      await expect(act(person, (api) => api.workspace())).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  });
});
