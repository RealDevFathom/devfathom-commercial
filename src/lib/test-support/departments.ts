/**
 * Test-only helper for the WHA-278 composite foreign key.
 *
 * `User.department` references `organization_departments(organizationId, key)`,
 * so a user row cannot be written before its organization's department catalog
 * exists. Production paths get this from `bootstrapOrganization` (and, for the
 * identity/seed paths, WHA-290); fixtures that insert an organization directly
 * have to seed the keys they use themselves.
 *
 * Rows are keyed by the department key itself rather than a vertical, so a
 * fixture declares exactly the departments its users are filed under and no
 * vertical-specific catalog leaks into a test that does not care about one.
 */
type DepartmentSeedDb = {
  organizationDepartment: {
    createMany: (args: {
      data: { organizationId: string; key: string; name: string; sortOrder: number }[];
      skipDuplicates?: boolean;
    }) => Promise<unknown>;
  };
};

export async function seedDepartments(
  db: DepartmentSeedDb,
  organizationIds: string[],
  keys: string[]
): Promise<void> {
  await db.organizationDepartment.createMany({
    data: organizationIds.flatMap((organizationId) =>
      keys.map((key, index) => ({ organizationId, key, name: key, sortOrder: index }))
    ),
    skipDuplicates: true,
  });
}

/**
 * Race-safe `platformModule` upsert for fixtures.
 *
 * `platform_modules` is control-plane data keyed by module key, and a dozen
 * database batteries each ensure the same `restaurant-pos` row. Vitest runs
 * those files in parallel against one database, and Prisma's upsert is a
 * read-then-write for this shape, so two files can both miss and then both
 * insert — one of them losing on the unique index.
 *
 * Treat the unique violation as proof that the row now exists and read it back.
 */
type PlatformModuleCreate = { key: string; name: string; category: string; active?: boolean };

type PlatformModuleDb = {
  platformModule: {
    upsert(args: {
      where: { key: string };
      update: Record<string, never>;
      create: PlatformModuleCreate;
    }): Promise<{ id: string }>;
    findUniqueOrThrow(args: { where: { key: string } }): Promise<{ id: string }>;
  };
};

export async function ensurePlatformModule(
  db: PlatformModuleDb,
  key: string,
  create: Omit<PlatformModuleCreate, 'key'>
): Promise<{ id: string }> {
  try {
    return await db.platformModule.upsert({
      where: { key },
      update: {},
      create: { key, ...create },
    });
  } catch {
    return await db.platformModule.findUniqueOrThrow({ where: { key } });
  }
}
