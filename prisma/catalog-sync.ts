import { isDeepStrictEqual } from 'node:util';

import type { Prisma } from '../src/generated/prisma/client.js';
import { MODULE_CATALOG } from '../src/lib/module-catalog.js';
import {
  HOSPITALITY_PACKAGES,
  packageDefaultSeats,
  PHARMACY_PACKAGES,
  RESTAURANT_PACKAGES,
} from '../src/lib/vertical-catalog.js';

/**
 * Agency modules, as `[key, name, category, routePrefix]`. The restaurant half
 * of the catalog is declared in `src/lib/vertical-catalog.ts`.
 */
/** Sellable Agency Suite composition: shared platform plus Agency vertical modules, no baseline. */
export const AGENCY_SUITE_MODULES = MODULE_CATALOG.filter(
  (module) =>
    module.band === 'PLATFORM' || (module.vertical === 'AGENCY' && module.band !== 'BASELINE')
).map(({ key, name, category, routePrefix }) => [key, name, category, routePrefix] as const);

/** The pre-band 18-row registry shape, retained only for migration snapshot fixtures. */
export const PLATFORM_MODULES = MODULE_CATALOG.filter(
  (module) =>
    module.key === 'dashboard' ||
    module.band === 'PLATFORM' ||
    (module.vertical === 'AGENCY' && module.band === 'VERTICAL_OPTIONAL')
).map(({ key, name, category, routePrefix }) => [key, name, category, routePrefix] as const);

/** Every module key the product ships, in registry order. */
const CATALOG_MODULES = MODULE_CATALOG;

export type PlatformCatalogSync = {
  modulesCreated: number;
  packagesCreated: number;
  linksCreated: number;
  /** Row id per catalog module key, so callers can compose packages without
   * re-upserting the modules this pass just reconciled. */
  moduleIds: Map<string, string>;
};

/**
 * Reconciles the platform module and package registry with the code catalog.
 *
 * Until now `prisma/production-bootstrap.ts` was the only writer of
 * RESTAURANT_MODULES and RESTAURANT_PACKAGES, and it runs solely on a fresh
 * production bootstrap; `seed.ts` registered PLATFORM_MODULES alone and no
 * migration inserts modules. A database provisioned before a module existed
 * therefore never received it — the staging database, created 2026-08-14,
 * still listed only the 18 agency modules and the Agency Suite package after
 * every restaurant migration had been applied.
 *
 * The reconciliation preserves operator customizations:
 *
 * - modules upsert with `update: {}`, so `active`, `sortOrder` and any
 *   name/category edit an operator made in SuperAdmin survive a deployment;
 * - existing vertical packages still at the legacy default of one
 *   seat receive the catalog seat default; customized seat values survive;
 * - an existing package otherwise stays unchanged — its module links are
 *   the live entitlements of every organization on it, so adding one here
 *   would grant a module nobody bought, and bumping its version would
 *   misreport an unchanged package as edited.
 *
 * Safe to run on every deployment, and idempotent: a second pass returns zeros.
 */
export async function syncPlatformCatalog(
  tx: Prisma.TransactionClient,
  scope?: { vertical: 'RESTAURANT'; packageKey: string }
): Promise<PlatformCatalogSync> {
  const restaurantPackage = scope
    ? RESTAURANT_PACKAGES.find((definition) => definition.key === scope.packageKey)
    : undefined;
  if (scope && (scope.vertical !== 'RESTAURANT' || !restaurantPackage)) {
    throw new Error('Invalid Restaurant catalog scope.');
  }
  const packages = restaurantPackage
    ? [restaurantPackage]
    : [...RESTAURANT_PACKAGES, ...PHARMACY_PACKAGES, ...HOSPITALITY_PACKAGES];
  const modules = restaurantPackage
    ? CATALOG_MODULES.filter(
        (module) => module.band === 'BASELINE' || restaurantPackage.moduleKeys.includes(module.key)
      )
    : CATALOG_MODULES;

  // A fresh bootstrap must not silently repair or expand an operator's entitlements.
  if (restaurantPackage) {
    const existingModules = await tx.platformModule.findMany({
      where: { key: { in: modules.map((module) => module.key) } },
    });
    if (
      existingModules.some((module) => {
        const definition = modules.find((candidate) => candidate.key === module.key)!;
        return (
          !module.active ||
          module.band !== definition.band ||
          module.vertical !== definition.vertical
        );
      })
    ) {
      throw new Error('Restaurant catalog module conflicts with the code catalog.');
    }
    const existingPackage = await tx.platformPackage.findUnique({
      where: { key: restaurantPackage.key },
      include: { moduleLinks: { include: { module: true } } },
    });
    if (
      existingPackage &&
      (!existingPackage.active ||
        existingPackage.vertical !== 'RESTAURANT' ||
        existingPackage.moduleLinks.length !== restaurantPackage.moduleKeys.length ||
        existingPackage.moduleLinks.some(
          (link) =>
            !link.enabled ||
            !link.module.active ||
            !restaurantPackage.moduleKeys.includes(link.module.key) ||
            !isDeepStrictEqual(
              link.limits,
              link.module.key.endsWith('-core') ? restaurantPackage.defaultLimits : null
            )
        ))
    ) {
      throw new Error('Restaurant package conflicts with the code catalog; review it explicitly.');
    }
  }
  const existingModuleKeys = new Set(
    (
      await tx.platformModule.findMany({
        where: { key: { in: modules.map((definition) => definition.key) } },
        select: { key: true },
      })
    ).map((row) => row.key)
  );

  const moduleIds = new Map<string, string>();
  let modulesCreated = 0;
  for (const definition of modules) {
    const platformModule = await tx.platformModule.upsert({
      where: { key: definition.key },
      update: {},
      create: {
        key: definition.key,
        name: definition.name,
        category: definition.category,
        routePrefix: definition.routePrefix,
        band: definition.band,
        vertical: definition.vertical,
      },
    });
    moduleIds.set(definition.key, platformModule.id);
    if (!existingModuleKeys.has(definition.key)) modulesCreated += 1;
  }

  const existingPackageKeys = new Set(
    (
      await tx.platformPackage.findMany({
        where: {
          key: {
            in: packages.map((definition) => definition.key),
          },
        },
        select: { key: true },
      })
    ).map((row) => row.key)
  );

  let packagesCreated = 0;
  let linksCreated = 0;
  for (const definition of packages) {
    if (existingPackageKeys.has(definition.key)) {
      if (packageDefaultSeats(definition) !== undefined) {
        // Guard the write itself so a concurrent admin seat edit also survives.
        await tx.platformPackage.updateMany({
          where: { key: definition.key, defaultSeats: 1 },
          data: { defaultSeats: packageDefaultSeats(definition) },
        });
      }
      continue;
    }

    const platformPackage = await tx.platformPackage.upsert({
      where: { key: definition.key },
      update: {},
      create: {
        key: definition.key,
        name: definition.name,
        vertical: definition.vertical,
        // Offer the package at its catalog seat ceiling rather than the column's
        // single-seat default, so the operator sees Essentials 10 / Pro 50 /
        // Chain 2500 for pharmacy instead of every tier reading "1 default seat".
        defaultSeats: packageDefaultSeats(definition),
      },
    });
    packagesCreated += 1;

    for (const moduleKey of definition.moduleKeys) {
      const moduleId = moduleIds.get(moduleKey);
      if (!moduleId) throw new Error(`Unknown vertical module: ${moduleKey}`);
      await tx.platformPackageModule.upsert({
        where: { packageId_moduleId: { packageId: platformPackage.id, moduleId } },
        update: {},
        create: {
          packageId: platformPackage.id,
          moduleId,
          limits: moduleKey.endsWith('-core') ? definition.defaultLimits : undefined,
        },
      });
      linksCreated += 1;
    }
  }

  console.log(
    `Platform catalog sync: created ${modulesCreated} module(s), ${packagesCreated} package(s), ${linksCreated} package-module link(s).`
  );

  return { modulesCreated, packagesCreated, linksCreated, moduleIds };
}
