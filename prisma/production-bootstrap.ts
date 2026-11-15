import { hash } from 'bcryptjs';
import { z } from 'zod';

import type { Prisma } from '../src/generated/prisma/client.js';
import {
  adminDepartmentKeyForVertical,
  defaultDepartmentRowsForVertical,
  RESTAURANT_PACKAGES,
  roleTemplatesForVertical,
} from '../src/lib/vertical-catalog.js';
import { AGENCY_SUITE_MODULES, syncPlatformCatalog } from './catalog-sync.js';

export { AGENCY_SUITE_MODULES, PLATFORM_MODULES } from './catalog-sync.js';

type BootstrapAdministrators = {
  organizationId: string;
  adminName: string;
  adminEmail: string;
  adminPassword?: string;
  adminTitle: string;
  platformAdminName: string;
  platformAdminEmail: string;
  platformAdminPassword?: string;
};

const identity = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const name = z.string().trim().min(1).max(200);
const restaurantInput = z.object({
  mode: z.literal('RESTAURANT'),
  organizationId: identity,
  organizationSlug: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  organizationLegalName: name,
  organizationDisplayName: name,
  packageKey: z.string().refine((key) => RESTAURANT_PACKAGES.some((pkg) => pkg.key === key)),
  adminId: identity,
  adminName: name,
  adminEmail: z.string().trim().toLowerCase().email(),
  adminPassword: z.string().optional(),
  adminTitle: name,
  platformAdminId: identity,
  platformAdminName: name,
  platformAdminEmail: z.string().trim().toLowerCase().email(),
  platformAdminPassword: z.string().optional(),
});

export type RestaurantBootstrapInput = z.infer<typeof restaurantInput>;
export type ProductionBootstrapInput =
  (BootstrapAdministrators & { mode?: 'AGENCY'; deploymentUrl: string }) | RestaurantBootstrapInput;

/** Pure CLI mapping: Restaurant identities have no fallback values. */
export function productionBootstrapInputFromEnvironment(
  env: Record<string, string | undefined>
): ProductionBootstrapInput {
  const required = (key: string) => {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Missing required environment variable: ${key}`);
    return value;
  };
  const mode = env.BOOTSTRAP_MODE;
  if (mode !== undefined && mode !== 'AGENCY' && mode !== 'RESTAURANT') {
    throw new Error('Invalid BOOTSTRAP_MODE.');
  }
  if (mode === 'RESTAURANT') {
    return validateRestaurantInput({
      mode,
      organizationId: required('ORGANIZATION_ID'),
      organizationSlug: required('ORGANIZATION_SLUG'),
      organizationLegalName: required('ORGANIZATION_LEGAL_NAME'),
      organizationDisplayName: required('ORGANIZATION_DISPLAY_NAME'),
      packageKey: required('BOOTSTRAP_PACKAGE_KEY'),
      adminId: required('ADMIN_ID'),
      adminName: required('ADMIN_NAME'),
      adminEmail: required('ADMIN_EMAIL'),
      adminPassword: env.ADMIN_PASSWORD,
      adminTitle: required('ADMIN_TITLE'),
      platformAdminId: required('PLATFORM_ADMIN_ID'),
      platformAdminName: required('PLATFORM_ADMIN_NAME'),
      platformAdminEmail: required('PLATFORM_ADMIN_EMAIL'),
      platformAdminPassword: env.PLATFORM_ADMIN_PASSWORD,
    });
  }
  return {
    organizationId:
      env.DEFAULT_ORGANIZATION_ID?.trim() || env.ORGANIZATION_ID?.trim() || 'org_devfathom',
    adminName: env.ADMIN_NAME?.trim() || 'Workspace Administrator',
    adminEmail: required('ADMIN_EMAIL'),
    adminPassword: env.ADMIN_PASSWORD,
    adminTitle: env.ADMIN_TITLE?.trim() || 'Administrator',
    platformAdminName: env.PLATFORM_ADMIN_NAME?.trim() || 'Platform Administrator',
    platformAdminEmail: required('PLATFORM_ADMIN_EMAIL'),
    platformAdminPassword: env.PLATFORM_ADMIN_PASSWORD,
    deploymentUrl: required('AUTH_URL'),
  };
}

function validateRestaurantInput(input: RestaurantBootstrapInput): RestaurantBootstrapInput {
  const parsed = restaurantInput.safeParse(input);
  if (!parsed.success)
    throw new Error('Invalid Restaurant bootstrap identity or package selection.');
  const value = parsed.data;
  if (value.adminId === value.platformAdminId || value.adminEmail === value.platformAdminEmail) {
    throw new Error('Restaurant bootstrap administrator identities must be distinct.');
  }
  return value;
}

type PasswordHasher = (password: string) => Promise<string>;

function initialPassword(password: string | undefined): string {
  if (!password || password.trim().length < 12) {
    throw new Error('Missing or invalid production bootstrap credential.');
  }
  return password;
}

export async function bootstrapProduction(
  tx: Prisma.TransactionClient,
  input: ProductionBootstrapInput,
  hashPassword: PasswordHasher = (password) => hash(password, 12)
) {
  if (input.mode === 'RESTAURANT') {
    return bootstrapRestaurant(tx, validateRestaurantInput(input), hashPassword);
  }
  if (input.mode !== undefined && input.mode !== 'AGENCY') {
    throw new Error('Invalid production bootstrap mode.');
  }
  const adminEmail = input.adminEmail.trim().toLowerCase();
  const platformAdminEmail = input.platformAdminEmail.trim().toLowerCase();
  const deploymentUrl = input.deploymentUrl.trim();

  await tx.$executeRawUnsafe(
    `SELECT set_config('app.is_platform_admin', 'true', true),
            set_config('app.current_organization_id', $1, true)`,
    input.organizationId
  );

  const existingAdmin = await tx.user.findFirst({
    where: {
      organizationId: input.organizationId,
      email: { equals: adminEmail, mode: 'insensitive' },
    },
    select: { id: true },
  });
  const existingPlatformAdmin = await tx.platformUser.findFirst({
    where: { email: { equals: platformAdminEmail, mode: 'insensitive' } },
    select: { id: true },
  });
  const adminPassword = existingAdmin ? undefined : initialPassword(input.adminPassword);
  const platformAdminPassword = existingPlatformAdmin
    ? undefined
    : initialPassword(input.platformAdminPassword);

  const suite = await tx.platformPackage.upsert({
    where: { key: 'agency-suite' },
    update: {},
    create: {
      key: 'agency-suite',
      name: 'Agency Suite',
      description: 'Complete DevFathom agency operating system.',
      vertical: 'AGENCY',
      defaultSeats: 25,
    },
  });

  const organization = await tx.organization.upsert({
    where: { id: input.organizationId },
    update: {},
    create: {
      id: input.organizationId,
      slug: 'devfathom',
      legalName: 'DevFathom',
      displayName: 'DevFathom',
      status: 'ACTIVE',
      packageId: suite.id,
      timezone: 'Asia/Karachi',
      seatLimit: 1000,
      gracePeriodDays: 14,
      activatedAt: new Date(),
    },
  });

  // WHA-290: seed this organization's department catalog before the
  // administrator below, for the same reason bootstrapOrganization does —
  // `User.department` is a composite foreign key onto `organization_departments`
  // and an organization with an empty catalog cannot hold a single user. The
  // vertical is read back from the row so a re-run against an already-converted
  // organization seeds ITS vertical's departments, not the create default's.
  await tx.organizationDepartment.createMany({
    data: defaultDepartmentRowsForVertical(organization.vertical).map((department) => ({
      organizationId: organization.id,
      ...department,
    })),
    skipDuplicates: true,
  });

  // Modules and restaurant packages are reconciled by the shared helper, which
  // also runs on every deployment via `prisma/sync-catalog.ts`. Composing the
  // Agency Suite stays here: it is this bootstrap's own package, and the
  // organization created above points at it.
  const { moduleIds } = await syncPlatformCatalog(tx);

  for (const [key] of AGENCY_SUITE_MODULES) {
    const moduleId = moduleIds.get(key);
    if (!moduleId) throw new Error(`Unknown platform module: ${key}`);
    await tx.platformPackageModule.upsert({
      where: {
        packageId_moduleId: { packageId: suite.id, moduleId },
      },
      update: {},
      create: { packageId: suite.id, moduleId },
    });
    // §2.3: the bootstrap org inherits its modules live from the package
    // (platform_package_modules); no OrganizationModule copy. assertActivationReady
    // remains satisfied by the package's moduleLinks.
  }

  const adminRole = await tx.organizationRole.upsert({
    where: {
      organizationId_key: { organizationId: input.organizationId, key: 'admin' },
    },
    update: {},
    create: {
      organizationId: input.organizationId,
      key: 'admin',
      name: 'Administrator',
      description: 'Full organization administration.',
      isSystem: true,
    },
  });
  await tx.organizationRole.upsert({
    where: {
      organizationId_key: { organizationId: input.organizationId, key: 'member' },
    },
    update: {},
    create: {
      organizationId: input.organizationId,
      key: 'member',
      name: 'Member',
      description: 'Standard workspace member.',
      isSystem: true,
    },
  });
  await tx.organizationRolePermission.upsert({
    where: {
      organizationRoleId_capability: {
        organizationRoleId: adminRole.id,
        capability: '*',
      },
    },
    update: {},
    create: {
      organizationId: input.organizationId,
      organizationRoleId: adminRole.id,
      capability: '*',
      effect: 'ALLOW',
    },
  });

  await tx.organizationBrand.upsert({
    where: { organizationId: input.organizationId },
    update: {},
    create: { organizationId: input.organizationId },
  });
  await tx.organizationDeployment.upsert({
    where: {
      organizationId_environment: {
        organizationId: input.organizationId,
        environment: 'production',
      },
    },
    update: {},
    create: {
      organizationId: input.organizationId,
      environment: 'production',
      mode: 'SHARED',
      status: 'READY',
      provider: 'AWS_ECS',
      url: deploymentUrl,
    },
  });

  if (!existingAdmin && adminPassword) {
    await tx.user.create({
      data: {
        organizationId: input.organizationId,
        organizationRoleId: adminRole.id,
        name: input.adminName,
        email: adminEmail,
        password: await hashPassword(adminPassword),
        role: 'ADMIN',
        department: adminDepartmentKeyForVertical(organization.vertical),
        title: input.adminTitle,
        status: 'ACTIVE',
      },
    });
  }

  if (!existingPlatformAdmin && platformAdminPassword) {
    await tx.platformUser.create({
      data: {
        name: input.platformAdminName,
        email: platformAdminEmail,
        passwordHash: await hashPassword(platformAdminPassword),
        role: 'SUPER_ADMIN',
        active: true,
      },
    });
  }
}

async function bootstrapRestaurant(
  tx: Prisma.TransactionClient,
  input: RestaurantBootstrapInput,
  hashPassword: PasswordHasher
) {
  await tx.$executeRawUnsafe(
    `SELECT set_config('app.is_platform_admin', 'true', true),
            set_config('app.current_organization_id', $1, true)`,
    input.organizationId
  );
  // Serialize bootstrap checks across both account namespaces; unique indexes remain authoritative.
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(734219061)`);
  const identities = {
    OR: [
      { id: { in: [input.adminId, input.platformAdminId] } },
      { email: { equals: input.adminEmail, mode: 'insensitive' as const } },
      { email: { equals: input.platformAdminEmail, mode: 'insensitive' as const } },
    ],
  };
  const organizations = await tx.organization.findMany({
    where: { OR: [{ id: input.organizationId }, { slug: input.organizationSlug }] },
  });
  const users = await tx.user.findMany({
    where: identities,
    select: { id: true, organizationId: true, email: true },
  });
  const platformUsers = await tx.platformUser.findMany({
    where: identities,
    select: { id: true, email: true },
  });
  const organization = organizations[0];
  if (organization) {
    const selectedPackage = await tx.platformPackage.findUnique({
      where: { key: input.packageKey },
    });
    if (
      organizations.length !== 1 ||
      organization.id !== input.organizationId ||
      organization.slug !== input.organizationSlug ||
      organization.legalName !== input.organizationLegalName ||
      organization.displayName !== input.organizationDisplayName ||
      organization.vertical !== 'RESTAURANT' ||
      organization.isDemo ||
      !selectedPackage ||
      selectedPackage.vertical !== 'RESTAURANT' ||
      organization.packageId !== selectedPackage.id ||
      users.length !== 1 ||
      users[0].id !== input.adminId ||
      users[0].organizationId !== input.organizationId ||
      users[0].email.toLowerCase() !== input.adminEmail ||
      platformUsers.length !== 1 ||
      platformUsers[0].id !== input.platformAdminId ||
      platformUsers[0].email.toLowerCase() !== input.platformAdminEmail
    ) {
      throw new Error('Restaurant bootstrap identity collision; explicit review required.');
    }
    // Replay never repairs accounts, permissions, packages, or operator changes.
    return;
  }
  if (users.length || platformUsers.length) {
    throw new Error('Restaurant bootstrap identity collision; explicit review required.');
  }
  const adminPassword = initialPassword(input.adminPassword);
  const platformAdminPassword = initialPassword(input.platformAdminPassword);
  if (
    new TextEncoder().encode(adminPassword).length > 72 ||
    new TextEncoder().encode(platformAdminPassword).length > 72
  ) {
    throw new Error('Invalid Restaurant bootstrap credential length.');
  }
  const password = await hashPassword(adminPassword);
  const passwordHash = await hashPassword(platformAdminPassword);
  await syncPlatformCatalog(tx, { vertical: 'RESTAURANT', packageKey: input.packageKey });
  const selectedPackage = await tx.platformPackage.findUniqueOrThrow({
    where: { key: input.packageKey },
  });
  await tx.organization.create({
    data: {
      id: input.organizationId,
      slug: input.organizationSlug,
      legalName: input.organizationLegalName,
      displayName: input.organizationDisplayName,
      vertical: 'RESTAURANT',
      status: 'ONBOARDING',
      isDemo: false,
      packageId: selectedPackage.id,
      seatLimit: selectedPackage.defaultSeats,
    },
  });
  await tx.organizationDepartment.createMany({
    data: defaultDepartmentRowsForVertical('RESTAURANT').map((department) => ({
      organizationId: input.organizationId,
      ...department,
    })),
  });
  let ownerRoleId: string | undefined;
  for (const template of roleTemplatesForVertical('RESTAURANT')) {
    const role = await tx.organizationRole.create({
      data: {
        organizationId: input.organizationId,
        key: template.key,
        name: template.name,
        isSystem: template.isSystem,
        permissions: {
          create: template.capabilities.map((capability) => ({
            organizationId: input.organizationId,
            capability,
            effect: 'ALLOW',
          })),
        },
      },
    });
    if (template.key === 'owner') ownerRoleId = role.id;
  }
  if (!ownerRoleId) throw new Error('Restaurant owner role is missing from the catalog.');
  await tx.organizationBrand.create({ data: { organizationId: input.organizationId } });
  await tx.user.create({
    data: {
      id: input.adminId,
      organizationId: input.organizationId,
      organizationRoleId: ownerRoleId,
      name: input.adminName,
      email: input.adminEmail,
      password,
      role: 'ADMIN',
      department: adminDepartmentKeyForVertical('RESTAURANT'),
      title: input.adminTitle,
      status: 'ACTIVE',
    },
  });
  await tx.platformUser.create({
    data: {
      id: input.platformAdminId,
      name: input.platformAdminName,
      email: input.platformAdminEmail,
      passwordHash,
      role: 'SUPER_ADMIN',
      active: true,
    },
  });
  // Deployment evidence is written only by the real deployment workflow.
}
