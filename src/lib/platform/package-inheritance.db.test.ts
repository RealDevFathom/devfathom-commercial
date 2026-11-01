/**
 * §2.3 package-module inheritance, against a REAL PostgreSQL.
 *
 * The correction removes the onboarding/bootstrap/seed copies of package modules
 * into `organization_modules`. What has to be true after that change is only
 * observable end-to-end, through the resolver and the cleanup migration:
 *
 *   (a) an org on a package resolves that package's modules as source PACKAGE
 *       with ZERO `organization_modules` rows;
 *   (b) changing the package leaves exactly the new package's modules enabled —
 *       no stragglers from the old package;
 *   (c) explicit overrides (an explicit DISABLE, and an extra ENABLE) survive a
 *       package change and stay final;
 *   (d) the cleanup migration's DELETE removes exactly the provably-redundant
 *       copies and leaves operator/contract/ambiguous rows intact, with the
 *       resolved enabled-state unchanged for package-covered modules.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped rather than passing
 * vacuously.
 *
 * DELIBERATELY DOES NOT CALL `assertRlsEnforcingRole` (#39), for the same reason
 * as audit-secret-redaction.test.ts: nothing here is DECIDED BY row level
 * security. Every setup/read goes through `withPlatformDb` (which sets
 * `app.is_platform_admin` on purpose) or the resolver's own tenant/platform
 * scoping, every organization id is unique per run, and every query filters by
 * organizationId. Wider visibility cannot reach the asserted rows, so the suite
 * is valid on a superuser TEST_DATABASE_URL too.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// `@/lib/db` reads DATABASE_URL when its module is evaluated, so this must
// happen before the dynamic imports in `beforeAll`.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const suffix = randomBytes(6).toString('hex');

type Deps = {
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  resolveOrganizationEntitlements: (typeof import('@/lib/entitlements'))['resolveOrganizationEntitlements'];
};

let deps: Deps;

// Package A enables a1..a6; package B enables b1,b2; `free` is in no package.
const MODULE_NAMES = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1', 'b2', 'free'] as const;
type ModuleName = (typeof MODULE_NAMES)[number];

const moduleId = (name: ModuleName) => `mod_${name}_${suffix}`;
const moduleKey = (name: ModuleName) => `inh_${name}_${suffix}`;

const PKG_A_ID = `pkg_a_${suffix}`;
const PKG_B_ID = `pkg_b_${suffix}`;
const PKG_A_NAME = `Inheritance Package A ${suffix}`;
const PKG_B_NAME = `Inheritance Package B ${suffix}`;

const ORG_AB = `org_ab_${suffix}`; // switches A -> B (tests a, b)
const ORG_OVR = `org_ovr_${suffix}`; // overrides survive a switch (test c)
const ORG_LEG = `org_leg_${suffix}`; // legacy copied rows + migration (test d)
const ALL_ORGS = [ORG_AB, ORG_OVR, ORG_LEG];

const resolve = (organizationId: string) =>
  deps.resolveOrganizationEntitlements(organizationId, deps.createTenantDb(organizationId));

/** enabled/source keyed by module key, for before/after comparisons. */
const byKey = (modules: Awaited<ReturnType<typeof resolve>>['modules']) =>
  Object.fromEntries(modules.map((m) => [m.key, { enabled: m.enabled, source: m.source }]));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('package-module inheritance, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    const entitlements = await import('@/lib/entitlements');
    deps = {
      withPlatformDb: scopedDb.withPlatformDb,
      createTenantDb: scopedDb.createTenantDb,
      resolveOrganizationEntitlements: entitlements.resolveOrganizationEntitlements,
    };

    await deps.withPlatformDb(async (db) => {
      for (const name of MODULE_NAMES) {
        await db.platformModule.create({
          data: {
            id: moduleId(name),
            key: moduleKey(name),
            name: `Inheritance ${name} ${suffix}`,
            category: 'inheritance-test',
            band: 'PLATFORM',
            active: true,
          },
        });
      }

      await db.platformPackage.create({
        data: { id: PKG_A_ID, key: `inhpkg_a_${suffix}`, name: PKG_A_NAME, defaultSeats: 25 },
      });
      await db.platformPackage.create({
        data: { id: PKG_B_ID, key: `inhpkg_b_${suffix}`, name: PKG_B_NAME, defaultSeats: 25 },
      });
      for (const name of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] as ModuleName[]) {
        await db.platformPackageModule.create({
          data: { packageId: PKG_A_ID, moduleId: moduleId(name), enabled: true },
        });
      }
      for (const name of ['b1', 'b2'] as ModuleName[]) {
        await db.platformPackageModule.create({
          data: { packageId: PKG_B_ID, moduleId: moduleId(name), enabled: true },
        });
      }

      for (const [id, name] of [
        [ORG_AB, 'AB'],
        [ORG_OVR, 'Overrides'],
        [ORG_LEG, 'Legacy'],
      ] as const) {
        await db.organization.create({
          data: {
            id,
            slug: id.replaceAll('_', '-'),
            legalName: `Inheritance ${name} ${suffix}`,
            displayName: `Inheritance ${name}`,
            status: 'ACTIVE',
            packageId: PKG_A_ID,
            seatLimit: 100,
          },
        });
      }
    });
  }, 60_000);

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(async (db) => {
      await db.organizationModule.deleteMany({ where: { organizationId: { in: ALL_ORGS } } });
      await db.organization.deleteMany({ where: { id: { in: ALL_ORGS } } });
      await db.platformPackageModule.deleteMany({
        where: { packageId: { in: [PKG_A_ID, PKG_B_ID] } },
      });
      await db.platformPackage.deleteMany({ where: { id: { in: [PKG_A_ID, PKG_B_ID] } } });
      await db.platformModule.deleteMany({
        where: { id: { in: MODULE_NAMES.map((name) => moduleId(name)) } },
      });
    });
  }, 60_000);

  it('(a) resolves package modules as PACKAGE with zero OrganizationModule rows', async () => {
    const rows = await deps.withPlatformDb((db) =>
      db.organizationModule.count({ where: { organizationId: ORG_AB } })
    );
    expect(rows).toBe(0);

    const entitlements = await resolve(ORG_AB);
    const enabled = [...entitlements.enabledModules].sort();
    expect(enabled).toEqual(
      [
        'admin',
        'api',
        'identity',
        'team',
        'dashboard',
        'notifications',
        ...(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] as ModuleName[]).map(moduleKey),
      ].sort()
    );
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] as ModuleName[]) {
      expect(entitlements.modules.find((m) => m.key === moduleKey(name))).toMatchObject({
        enabled: true,
        source: 'PACKAGE',
      });
    }
    // Package B's modules are not enabled for an org on package A.
    expect(entitlements.enabledModules).not.toContain(moduleKey('b1'));
  });

  it('(b) switching the package leaves exactly the new modules, no A stragglers', async () => {
    await deps.withPlatformDb((db) =>
      db.organization.update({ where: { id: ORG_AB }, data: { packageId: PKG_B_ID } })
    );

    const entitlements = await resolve(ORG_AB);
    expect([...entitlements.enabledModules].sort()).toEqual(
      [
        'admin',
        'api',
        'identity',
        'team',
        'dashboard',
        'notifications',
        moduleKey('b1'),
        moduleKey('b2'),
      ].sort()
    );
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] as ModuleName[]) {
      expect(entitlements.enabledModules).not.toContain(moduleKey(name));
    }
    for (const name of ['b1', 'b2'] as ModuleName[]) {
      expect(entitlements.modules.find((m) => m.key === moduleKey(name))).toMatchObject({
        enabled: true,
        source: 'PACKAGE',
      });
    }
    // No copied rows were ever written, so there is nothing to strand.
    const rows = await deps.withPlatformDb((db) =>
      db.organizationModule.count({ where: { organizationId: ORG_AB } })
    );
    expect(rows).toBe(0);
  });

  it('(c) explicit overrides survive a package change and stay final', async () => {
    // Operator explicitly disables a1 (which package A enables) and explicitly
    // enables `free` (which no package provides).
    await deps.withPlatformDb(async (db) => {
      await db.organizationModule.create({
        data: {
          organizationId: ORG_OVR,
          moduleId: moduleId('a1'),
          status: 'DISABLED',
          reason: 'Operator disabled a1 for this org',
        },
      });
      await db.organizationModule.create({
        data: {
          organizationId: ORG_OVR,
          moduleId: moduleId('free'),
          status: 'ENABLED',
          reason: 'Operator enabled the free module early',
        },
      });
    });

    // Before the switch: overrides already win over the package baseline.
    const before = byKey((await resolve(ORG_OVR)).modules);
    expect(before[moduleKey('a1')]).toEqual({ enabled: false, source: 'OVERRIDE' });
    expect(before[moduleKey('free')]).toEqual({ enabled: true, source: 'OVERRIDE' });

    // Switch package A -> B.
    await deps.withPlatformDb((db) =>
      db.organization.update({ where: { id: ORG_OVR }, data: { packageId: PKG_B_ID } })
    );

    const after = await resolve(ORG_OVR);
    const afterByKey = byKey(after.modules);
    // Both overrides survive the package change and remain final.
    expect(afterByKey[moduleKey('a1')]).toEqual({ enabled: false, source: 'OVERRIDE' });
    expect(afterByKey[moduleKey('free')]).toEqual({ enabled: true, source: 'OVERRIDE' });
    // The disabled override keeps a1 off; the extra enable keeps `free` on.
    expect(after.enabledModules).not.toContain(moduleKey('a1'));
    expect(after.enabledModules).toContain(moduleKey('free'));
    // Package B's own modules resolve normally alongside the overrides.
    expect(after.enabledModules).toEqual(
      expect.arrayContaining([moduleKey('b1'), moduleKey('b2'), moduleKey('free')])
    );
  });

  it('(d) the cleanup migration deletes exactly the redundant copies', async () => {
    // Seed legacy-shaped rows for org_leg (on package A, which enables a1..a6):
    //   a1 — redundant copy, current package name       -> DELETE
    //   a2 — redundant copy, NULL reason (bootstrap/seed)-> DELETE
    //   a3 — genuine operator override (reason >= 5)     -> keep
    //   a4 — contract-sync row ('Contract <n>')          -> keep
    //   a5 — copy shape but a seatLimit deviation        -> keep
    //   a6 — 'Included with <different package>' (drifted)-> keep (and WARN)
    await deps.withPlatformDb(async (db) => {
      await db.organizationModule.createMany({
        data: [
          {
            organizationId: ORG_LEG,
            moduleId: moduleId('a1'),
            status: 'ENABLED',
            reason: `Included with ${PKG_A_NAME}`,
          },
          { organizationId: ORG_LEG, moduleId: moduleId('a2'), status: 'ENABLED', reason: null },
          {
            organizationId: ORG_LEG,
            moduleId: moduleId('a3'),
            status: 'ENABLED',
            reason: 'Operator kept this module enabled',
          },
          {
            organizationId: ORG_LEG,
            moduleId: moduleId('a4'),
            status: 'ENABLED',
            reason: 'Contract 2026-0007',
          },
          {
            organizationId: ORG_LEG,
            moduleId: moduleId('a5'),
            status: 'ENABLED',
            seatLimit: 5,
            reason: `Included with ${PKG_A_NAME}`,
          },
          {
            organizationId: ORG_LEG,
            moduleId: moduleId('a6'),
            status: 'ENABLED',
            reason: 'Included with Some Legacy Suite',
          },
        ],
      });
    });

    const before = byKey((await resolve(ORG_LEG)).modules);
    // a1 is currently an OVERRIDE (the copied row); the migration should turn it
    // back into a PACKAGE source without changing its enabled state.
    expect(before[moduleKey('a1')]).toEqual({ enabled: true, source: 'OVERRIDE' });
    const enabledBefore = [...(await resolve(ORG_LEG)).enabledModules].sort();

    // Read the DELETE straight out of the migration file and run it under the
    // same control-plane scope the migration's `SET LOCAL app.is_platform_admin`
    // establishes.
    const migrationsRoot = path.join(process.cwd(), 'prisma', 'migrations');
    const migrationDir = readdirSync(migrationsRoot).find((entry) =>
      entry.endsWith('_package_module_inheritance_cleanup')
    );
    expect(migrationDir).toBeTruthy();
    const sql = readFileSync(path.join(migrationsRoot, migrationDir!, 'migration.sql'), 'utf8');
    const deleteStatement = sql.match(/DELETE FROM[\s\S]*?;/);
    expect(deleteStatement).not.toBeNull();

    const deleted = await deps.withPlatformDb((db) => db.$executeRawUnsafe(deleteStatement![0]));
    expect(deleted).toBe(2);

    // Exactly a1 and a2 are gone; a3..a6 remain untouched.
    const remaining = await deps.withPlatformDb((db) =>
      db.organizationModule.findMany({
        where: { organizationId: ORG_LEG },
        select: { moduleId: true, reason: true, seatLimit: true },
      })
    );
    expect(remaining.map((row) => row.moduleId).sort()).toEqual(
      (['a3', 'a4', 'a5', 'a6'] as ModuleName[]).map(moduleId).sort()
    );
    // The survivors kept their exact shape.
    const survivor = (name: ModuleName) => remaining.find((row) => row.moduleId === moduleId(name));
    expect(survivor('a3')!.reason).toBe('Operator kept this module enabled');
    expect(survivor('a4')!.reason).toBe('Contract 2026-0007');
    expect(survivor('a5')!.seatLimit).toBe(5);
    expect(survivor('a6')!.reason).toBe('Included with Some Legacy Suite');

    // Enabled-state resolution is identical before/after for package-covered
    // modules; only a1's source shifts OVERRIDE -> PACKAGE.
    const after = byKey((await resolve(ORG_LEG)).modules);
    expect([...(await resolve(ORG_LEG)).enabledModules].sort()).toEqual(enabledBefore);
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] as ModuleName[]) {
      expect(after[moduleKey(name)].enabled).toBe(before[moduleKey(name)].enabled);
    }
    expect(after[moduleKey('a1')]).toEqual({ enabled: true, source: 'PACKAGE' });
  });
});
