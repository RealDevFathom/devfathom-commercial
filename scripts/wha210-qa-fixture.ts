/**
 * WHA-210 visual-QA fixture. Local QA scaffolding only — never imported by the
 * app and never run against a real workspace. It exists so the DEVFATHOM-STUDIO
 * §12 gate for `/restaurant/menu-import` stays reproducible: without it the
 * route renders its empty state and the matrix proves nothing.
 *
 * Puts the seeded org into the exact state the console is meant to be reviewed
 * in: the module enabled, `menu:import` granted through an organization role,
 * and two extracted imports awaiting review (one of them the injection
 * fixture). Pair it with `tests/e2e/menu-import-visual-qa.spec.ts`.
 */
import { withPlatformDb, withTenantDb } from '../src/lib/tenancy/scoped-db';
import {
  createMenuImport,
  runMenuImportExtraction,
  type MenuImportRuntime,
} from '../src/lib/restaurant/menu-import';
import {
  createFixtureMenuExtractionAdapter,
  withFixtureMarker,
} from '../src/lib/restaurant/menu-extraction-fixtures';
import { moduleDefinitionForKey } from '../src/lib/module-catalog';
import { RESTAURANT_MODULES } from '../src/lib/vertical-catalog';

const ORG = 'org_devfathom';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** In-memory object store: the real driver is S3, which QA has no use for. */
const objects = new Map<string, Buffer>();
const runtime: MenuImportRuntime = {
  resolveAdapter: () => createFixtureMenuExtractionAdapter(),
  putSource: async (org, name, content) => {
    objects.set(`${org}/${name}`, content);
  },
  readSource: async (org, name) => {
    const found = objects.get(`${org}/${name}`);
    if (!found) throw new Error(`missing object ${org}/${name}`);
    return found;
  },
  deleteSource: async (org, name) => {
    objects.delete(`${org}/${name}`);
  },
};

async function main() {
  // 1. Catalog the restaurant modules the seed does not ship, then enable the
  //    one this console gates on. Catalog rows are control-plane only.
  await withPlatformDb(async (platformDb) => {
    for (const [index, module] of RESTAURANT_MODULES.entries()) {
      // `band` and the owning vertical are required registry facts; read them
      // from the module catalog rather than restating them here.
      const definition = moduleDefinitionForKey(module.key);
      if (!definition) throw new Error(`Unknown module key: ${module.key}`);
      await platformDb.platformModule.upsert({
        where: { key: module.key },
        update: { active: true },
        create: {
          key: module.key,
          name: module.name,
          category: module.category,
          routePrefix: module.routePrefix ?? null,
          band: definition.band,
          vertical: definition.vertical,
          active: true,
          sortOrder: 100 + index,
        },
      });
    }
    const menuModule = await platformDb.platformModule.findUniqueOrThrow({
      where: { key: 'restaurant-menu' },
      select: { id: true },
    });
    await platformDb.organizationModule.upsert({
      where: { organizationId_moduleId: { organizationId: ORG, moduleId: menuModule.id } },
      update: { status: 'ENABLED' },
      create: { organizationId: ORG, moduleId: menuModule.id, status: 'ENABLED' },
    });
  });

  const adminId = await withTenantDb(ORG, async (db) => {
    // 2. Grant menu:import to the admin QA signs in as. Default deny otherwise.
    const admin = await db.user.findFirstOrThrow({
      where: { email: 'alex@company.com' },
      select: { id: true },
    });
    const existing = await db.organizationRole.findFirst({
      where: { key: 'qa-menu-importer' },
      select: { id: true },
    });
    const roleId =
      existing?.id ??
      (
        await db.organizationRole.create({
          data: {
            key: 'qa-menu-importer',
            name: 'QA Menu Importer',
            permissions: { create: [{ capability: 'menu:import', effect: 'ALLOW' }] },
          },
          select: { id: true },
        })
      ).id;
    await db.user.update({ where: { id: admin.id }, data: { organizationRoleId: roleId } });

    // 3. A catalog product so "merge into existing" has a real target.
    const product = await db.restaurantProduct.findFirst({
      where: { name: 'Chicken Karahi' },
      select: { id: true },
    });
    if (!product) {
      const created = await db.restaurantProduct.create({
        data: { name: 'Chicken Karahi', status: 'ACTIVE', sortOrder: 0 },
        select: { id: true },
      });
      await db.restaurantProductVariant.create({
        data: { productId: created.id, name: 'Full', sortOrder: 0 },
      });
    }
    return admin.id;
  });

  // 4. Two real imports, uploaded and extracted through the domain layer.
  for (const fixture of ['default', 'injection'] as const) {
    const importId = await withTenantDb(ORG, async (db) => {
      const created = await createMenuImport(
        db,
        ORG,
        {
          fileName: `qa-${fixture}-menu.png`,
          content: withFixtureMarker(PNG, fixture),
          declaredMimeType: 'image/png',
          createdById: adminId,
          adapter: 'FIXTURE',
          defaultCurrency: 'PKR',
          idempotencyKey: `wha210-qa-${fixture}`,
        },
        { runtime }
      );
      return created.importId;
    });
    const outcome = await withTenantDb(ORG, (db) =>
      runMenuImportExtraction(db, importId, { runtime })
    );
    console.log(`${fixture}: ${importId} -> ${outcome.status}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
