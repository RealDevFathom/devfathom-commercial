import { hash } from 'bcryptjs';

import type { Prisma } from '../src/generated/prisma/client.js';

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
      defaultSeats: 25,
    },
  });

  await tx.organization.upsert({
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

  for (const [key, name, category, routePrefix] of PLATFORM_MODULES) {
    const platformModule = await tx.platformModule.upsert({
      where: { key },
      update: {},
      create: { key, name, category, routePrefix },
    });
    await tx.platformPackageModule.upsert({
      where: {
        packageId_moduleId: { packageId: suite.id, moduleId: platformModule.id },
      },
      update: {},
      create: { packageId: suite.id, moduleId: platformModule.id },
    });
    await tx.organizationModule.upsert({
      where: {
        organizationId_moduleId: {
          organizationId: input.organizationId,
          moduleId: platformModule.id,
        },
      },
      update: {},
      create: {
        organizationId: input.organizationId,
        moduleId: platformModule.id,
        status: 'ENABLED',
      },
    });
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
        department: 'LEADERSHIP',
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
