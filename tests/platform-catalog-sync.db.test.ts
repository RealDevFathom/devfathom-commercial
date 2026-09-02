/**
 * Module and package registry reconciliation, against a REAL PostgreSQL.
 *
 * `prisma/production-bootstrap.ts` was the only writer of RESTAURANT_MODULES
 * and RESTAURANT_PACKAGES, and it runs solely on a fresh production bootstrap.
 * `seed.ts` registered PLATFORM_MODULES alone and no migration inserts modules,
 * so a database provisioned before a module shipped never received it — the
 * staging database, created 2026-08-14, still listed only the 18 agency modules
 * and the Agency Suite package after every restaurant migration had applied.
 *
 * Two properties matter, and only one of them is "the rows appear":
 *
 *   (a) reconciling the Aug-14 SHAPE (PLATFORM_MODULES + an Agency Suite linked
 *       to all 18 + an organization on that package) registers every restaurant
 *       module and package WITHOUT touching the existing package: its links and
 *       its version are unchanged, and the organization's resolved entitlements
 *       grant exactly the same modules with exactly the same limits as before;
 *   (b) the pass is idempotent — a second run creates nothing and leaves every
 *       catalog row byte-identical.
 *
 * Expected creation counts are measured against the registry as found rather
 * than hardcoded, because the batteries this suite shares a database with each
 * ensure their own `restaurant-*` module rows.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped rather than
 * passing vacuously.
 *
 * DELIBERATELY DOES NOT CALL `assertRlsEnforcingRole`: nothing here is DECIDED
 * BY row level security. Every setup and read goes through `withPlatformDb`
 * (which sets `app.is_platform_admin` on purpose, exactly as the migration
 * job's own transaction does) or the resolver's tenant/platform scoping, and
 * the organization id and suite key are unique per run.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RESTAURANT_MODULES, RESTAURANT_PACKAGES } from '@/lib/vertical-catalog';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// `@/lib/db` reads DATABASE_URL when its module is evaluated, so this must
// happen before the dynamic imports in `beforeAll`.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const suffix = randomBytes(6).toString('hex');
const SUITE_KEY = `agency-suite-${suffix}`;
const ORG_ID = `org_aug14_${suffix}`;

type Deps = {
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  resolveOrganizationEntitlements: (typeof import('@/lib/entitlements'))['resolveOrganizationEntitlements'];
  syncPlatformCatalog: (typeof import('../prisma/catalog-sync'))['syncPlatformCatalog'];
  PLATFORM_MODULES: (typeof import('../prisma/catalog-sync'))['PLATFORM_MODULES'];
};

let deps: Deps;

/** Package keys this run created, so a second run finds the same registry it
 * did. Module rows are left behind on purpose: they are additive, and the other
 * batteries sharing this database ensure their own anyway. */
let createdPackageKeys: string[] = [];

const sync = () => deps.withPlatformDb((db) => deps.syncPlatformCatalog(db));

const resolve = () => deps.resolveOrganizationEntitlements(ORG_ID, deps.createTenantDb(ORG_ID));

/** Every catalog row that matters, as a comparable snapshot. */
const registrySnapshot = () =>
  deps.withPlatformDb(async (db) => {
    const modules = await db.platformModule.findMany({
      orderBy: { key: 'asc' },
      select: { key: true, name: true, category: true, active: true, sortOrder: true },
    });
    const packages = await db.platformPackage.findMany({
      orderBy: { key: 'asc' },
      select: {
        key: true,
        name: true,
        vertical: true,
        version: true,
        active: true,
        moduleLinks: {
          orderBy: { moduleId: 'asc' },
          select: { enabled: true, limits: true, module: { select: { key: true } } },
        },
      },
    });
    return { modules, packages };
  });

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('platform catalog reconciliation, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    const entitlements = await import('@/lib/entitlements');
    const catalogSync = await import('../prisma/catalog-sync');
    deps = {
      withPlatformDb: scopedDb.withPlatformDb,
      createTenantDb: scopedDb.createTenantDb,
      resolveOrganizationEntitlements: entitlements.resolveOrganizationEntitlements,
      syncPlatformCatalog: catalogSync.syncPlatformCatalog,
      PLATFORM_MODULES: catalogSync.PLATFORM_MODULES,
    };

    // The Aug-14 shape: the 18 agency modules, an agency package linked to all
    // of them, and an organization inheriting its entitlements from it.
    await deps.withPlatformDb(async (db) => {
      await db.platformModule.createMany({
        data: deps.PLATFORM_MODULES.map(([key, name, category, routePrefix]) => ({
          key,
          name,
          category,
          routePrefix,
        })),
        skipDuplicates: true,
      });
      const suite = await db.platformPackage.create({
        data: {
          key: SUITE_KEY,
          name: `Agency Suite ${suffix}`,
          vertical: 'AGENCY',
          defaultSeats: 25,
        },
      });
      for (const [key] of deps.PLATFORM_MODULES) {
        const platformModule = await db.platformModule.findUniqueOrThrow({ where: { key } });
        await db.platformPackageModule.create({
          data: { packageId: suite.id, moduleId: platformModule.id, enabled: true },
        });
      }
      await db.organization.create({
        data: {
          id: ORG_ID,
          slug: ORG_ID.replaceAll('_', '-'),
          legalName: `Aug 14 ${suffix}`,
          displayName: 'Aug 14',
          status: 'ACTIVE',
          packageId: suite.id,
          seatLimit: 100,
        },
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(async (db) => {
      await db.organizationModule.deleteMany({ where: { organizationId: ORG_ID } });
      await db.organization.deleteMany({ where: { id: ORG_ID } });
      const created = await db.platformPackage.findMany({
        where: { key: { in: [SUITE_KEY, ...createdPackageKeys] } },
        select: { id: true },
      });
      const ids = created.map((row) => row.id);
      await db.platformPackageModule.deleteMany({ where: { packageId: { in: ids } } });
      await db.platformPackage.deleteMany({ where: { id: { in: ids } } });
    });
  }, 60_000);

  it('(a) registers the restaurant catalog without moving a live entitlement', async () => {
    const before = await registrySnapshot();
    const beforeEntitlements = await resolve();
    const suiteBefore = before.packages.find((row) => row.key === SUITE_KEY);
    expect(suiteBefore?.moduleLinks).toHaveLength(deps.PLATFORM_MODULES.length);

    const registeredModules = new Set(before.modules.map((row) => row.key));
    const registeredPackages = new Set(before.packages.map((row) => row.key));
    const missingModules = RESTAURANT_MODULES.filter(
      (definition) => !registeredModules.has(definition.key)
    );
    const missingPackages = RESTAURANT_PACKAGES.filter(
      (definition) => !registeredPackages.has(definition.key)
    );
    // Restaurant module rows are ensured ad hoc by the batteries this suite
    // shares a database with, and this suite deliberately leaves its own behind
    // (deleting them would break their foreign keys), so the module count is
    // only asserted relative to what was actually missing. The packages are the
    // guaranteed-absent half — nothing but bootstrap and this helper ever
    // creates one — and they are what keeps the assertions below non-vacuous.
    expect(missingPackages).toHaveLength(RESTAURANT_PACKAGES.length);

    createdPackageKeys = missingPackages.map((definition) => definition.key);

    const result = await sync();
    expect(result.modulesCreated).toBe(missingModules.length);
    expect(result.packagesCreated).toBe(missingPackages.length);
    expect(result.linksCreated).toBe(
      missingPackages.reduce((total, definition) => total + definition.moduleKeys.length, 0)
    );

    const after = await registrySnapshot();

    for (const definition of RESTAURANT_MODULES) {
      expect(after.modules.map((row) => row.key)).toContain(definition.key);
    }
    for (const definition of RESTAURANT_PACKAGES) {
      const registered = after.packages.find((row) => row.key === definition.key);
      expect(registered).toBeDefined();
      expect(registered!.vertical).toBe('RESTAURANT');
      expect(registered!.moduleLinks.map((link) => link.module.key).sort()).toEqual(
        [...definition.moduleKeys].sort()
      );
      expect(
        registered!.moduleLinks.find((link) => link.module.key === 'restaurant-core')?.limits
      ).toEqual(definition.defaultLimits);
    }

    // The pre-existing package is untouched: same links, same version.
    expect(after.packages.find((row) => row.key === SUITE_KEY)).toEqual(suiteBefore);

    // The architecture gate: nothing this organization is entitled to moved.
    const afterEntitlements = await resolve();
    expect(afterEntitlements.enabledModules).toEqual(beforeEntitlements.enabledModules);
    expect(afterEntitlements.limits).toEqual(beforeEntitlements.limits);
    expect(afterEntitlements.seatLimit).toBe(beforeEntitlements.seatLimit);
    expect(afterEntitlements.activeSeats).toBe(beforeEntitlements.activeSeats);
    expect(afterEntitlements.vertical).toBe(beforeEntitlements.vertical);

    // `modules` is the whole active catalog by construction, so it necessarily
    // grows — but only by rows that are disabled and granted by nothing. Every
    // entry that existed before is byte-identical.
    const beforeByKey = new Map(beforeEntitlements.modules.map((entry) => [entry.key, entry]));
    for (const entry of afterEntitlements.modules) {
      const previous = beforeByKey.get(entry.key);
      if (previous) expect(entry).toEqual(previous);
      else expect(entry).toMatchObject({ enabled: false, source: 'NONE' });
    }
    expect(afterEntitlements.modules.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([...beforeByKey.keys()])
    );
  }, 120_000);

  it('(b) creates nothing and changes no row on a second pass', async () => {
    const before = await registrySnapshot();

    const result = await sync();

    expect(result).toMatchObject({ modulesCreated: 0, packagesCreated: 0, linksCreated: 0 });
    expect(await registrySnapshot()).toEqual(before);
  }, 120_000);
});
