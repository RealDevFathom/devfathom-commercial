import { hash } from 'bcryptjs';

import type { Prisma } from '../src/generated/prisma/client.js';
import {
  adminDepartmentKeyForVertical,
  defaultDepartmentRowsForVertical,
} from '../src/lib/vertical-catalog.js';
import { PLATFORM_MODULES, syncPlatformCatalog } from './catalog-sync.js';

export { PLATFORM_MODULES } from './catalog-sync.js';

export type ProductionBootstrapInput = {
  organizationId: string;
  adminName: string;
  adminEmail: string;
  adminPassword?: string;
  adminTitle: string;
  platformAdminName: string;
  platformAdminEmail: string;
  platformAdminPassword?: string;
  deploymentUrl: string;
};

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

  for (const [key] of PLATFORM_MODULES) {
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
      provider: 'AZURE_CONTAINER_APPS',
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
