import type { Prisma } from '../src/generated/prisma/client.js';
import { RESTAURANT_MODULES, RESTAURANT_PACKAGES } from '../src/lib/vertical-catalog.js';

/**
 * Agency modules, as `[key, name, category, routePrefix]`. The restaurant half
 * of the catalog is declared in `src/lib/vertical-catalog.ts`.
 */
export const PLATFORM_MODULES = [
  ['dashboard', 'Dashboard', 'Core', '/dashboard'],
  ['projects', 'Projects', 'Delivery', '/projects'],
  ['clients', 'Clients', 'Delivery', '/clients'],
  ['finance', 'Finance', 'Operations', '/finance'],
  ['chat', 'Chat', 'Collaboration', '/chat'],
  ['meetings', 'Meetings', 'Collaboration', '/meetings'],
  ['notes', 'Notes', 'Knowledge', '/notes'],
  ['hr', 'HR', 'People', '/hr'],
  ['reviews', 'Performance reviews', 'People', '/reviews'],
  ['email', 'Email', 'Communication', '/email'],
  ['api', 'API access', 'Developer', '/organization/api'],
  ['webhooks', 'Webhooks', 'Developer', '/organization/webhooks'],
  ['audit', 'Audit logs', 'Security', '/audit-logs'],
  ['branding', 'White-label branding', 'Configuration', '/organization/branding'],
  ['domains', 'Custom domains', 'Configuration', '/organization/domains'],
  ['identity', 'Enterprise SSO', 'Security', '/organization/authentication'],
  ['scim', 'SCIM provisioning', 'Security', '/organization/provisioning'],
  ['data', 'Data controls', 'Governance', '/organization/data'],
] as const;

type ModuleDefinition = {
  key: string;
  name: string;
  category: string;
  routePrefix: string;
};

/** Every module key the product ships, in registry order. */
const CATALOG_MODULES: readonly ModuleDefinition[] = [
  ...PLATFORM_MODULES.map(([key, name, category, routePrefix]) => ({
    key,
    name,
    category,
    routePrefix,
  })),
  ...RESTAURANT_MODULES.map(({ key, name, category, routePrefix }) => ({
    key,
    name,
    category,
    routePrefix,
  })),
];

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
 * The reconciliation is deliberately create-only:
 *
 * - modules upsert with `update: {}`, so `active`, `sortOrder` and any
 *   name/category edit an operator made in SuperAdmin survive a deployment;
 * - a package that already exists is skipped entirely — its module links are
 *   the live entitlements of every organization on it, so adding one here
 *   would grant a module nobody bought, and bumping its version would
 *   misreport an unchanged package as edited.
 *
 * Safe to run on every deployment, and idempotent: a second pass returns zeros.
 */
export async function syncPlatformCatalog(
  tx: Prisma.TransactionClient
): Promise<PlatformCatalogSync> {
  const existingModuleKeys = new Set(
    (
      await tx.platformModule.findMany({
        where: { key: { in: CATALOG_MODULES.map((definition) => definition.key) } },
        select: { key: true },
      })
    ).map((row) => row.key)
  );

  const moduleIds = new Map<string, string>();
  let modulesCreated = 0;
  for (const definition of CATALOG_MODULES) {
    const platformModule = await tx.platformModule.upsert({
      where: { key: definition.key },
      update: {},
      create: definition,
    });
    moduleIds.set(definition.key, platformModule.id);
    if (!existingModuleKeys.has(definition.key)) modulesCreated += 1;
  }

  const existingPackageKeys = new Set(
    (
      await tx.platformPackage.findMany({
        where: { key: { in: RESTAURANT_PACKAGES.map((definition) => definition.key) } },
        select: { key: true },
      })
    ).map((row) => row.key)
  );

  let packagesCreated = 0;
  let linksCreated = 0;
  for (const definition of RESTAURANT_PACKAGES) {
    if (existingPackageKeys.has(definition.key)) continue;

    const platformPackage = await tx.platformPackage.upsert({
      where: { key: definition.key },
      update: {},
      create: {
        key: definition.key,
        name: definition.name,
        vertical: definition.vertical,
      },
    });
    packagesCreated += 1;

    for (const moduleKey of definition.moduleKeys) {
      const moduleId = moduleIds.get(moduleKey);
      if (!moduleId) throw new Error(`Unknown restaurant module: ${moduleKey}`);
      await tx.platformPackageModule.upsert({
        where: { packageId_moduleId: { packageId: platformPackage.id, moduleId } },
        update: {},
        create: {
          packageId: platformPackage.id,
          moduleId,
          limits: moduleKey === 'restaurant-core' ? definition.defaultLimits : undefined,
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
