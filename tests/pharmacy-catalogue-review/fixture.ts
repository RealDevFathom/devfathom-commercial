import { PrismaClient } from '../../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashSync } from 'bcryptjs';
import { moduleDefinitionForKey } from '../../src/lib/module-catalog';
import { roleTemplatesForVertical } from '../../src/lib/vertical-catalog';
import { randomUUID } from 'node:crypto';
import { resolvePharmacyE2eDatabaseUrl } from '../../scripts/pharmacy-e2e-environment';
async function seedReviewWorkspace(group: string, members: readonly string[]) {
  const url = new URL(resolvePharmacyE2eDatabaseUrl({ ...process.env, STAGING_DEMO_SEED: '0' }));
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search)
    throw new Error('Use a local disposable database.');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }) });
  try {
    const [role] = await db.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; version: number }[]
    >`SELECT rolsuper,rolbypassrls,rolcreaterole,current_setting('server_version_num')::int AS version FROM pg_roles WHERE rolname=current_user`;
    if (
      !role ||
      role.rolsuper ||
      role.rolbypassrls ||
      role.rolcreaterole ||
      Math.floor(role.version / 10000) !== 16
    )
      throw new Error('Use restricted PostgreSQL 16.');
    const slug = 'review-' + group + '-' + randomUUID().slice(0, 8);
    const password = randomUUID(),
      approvalPin = '2846';

    const tmpl = roleTemplatesForVertical('PHARMACY');
    const passwd = hashSync(password, 10),
      pin = hashSync(approvalPin, 10);
    const pkg = slug;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin','true',true)`;
      await tx.platformPackage.create({
        data: { id: pkg, key: pkg, name: 'Import acceptance', vertical: 'PHARMACY' },
      });
      for (const key of [
        'pharmacy-core',
        'pharmacy-counter',
        'pharmacy-dispensing',
        'pharmacy-inventory',
        'hr',
      ]) {
        const def = moduleDefinitionForKey(key)!;
        const m = await tx.platformModule.upsert({
          where: { key },
          update: {},
          create: {
            key,
            name: def.name,
            category: def.category,
            band: def.band,
            vertical: def.vertical,
            routePrefix: def.routePrefix,
          },
        });
        await tx.platformPackageModule.create({ data: { packageId: pkg, moduleId: m.id } });
      }
    });

    const org = slug;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin','true',true),set_config('app.current_organization_id',${org},true)`;
      await tx.organization.create({
        data: {
          id: org,
          slug,
          displayName: 'Review ' + group,
          legalName: 'Review ' + group,
          vertical: 'PHARMACY',
          packageId: pkg,
          status: 'ACTIVE',
          deploymentMode: 'SHARED',
          requireApprovalAuthenticator: false,
          seatLimit: 12,
        },
      });
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin','false',true)`;
      await tx.organizationDepartment.create({
        data: { organizationId: org, key: 'TEAM', name: 'Team' },
      });
      const branch = await tx.pharmacyBranch.create({
        data: {
          organizationId: org,
          code: 'MAIN',
          name: 'Main',
          addressLine: '1 Road',
          city: 'Test City',
          provinceCode: 'PB',
        },
      });
      for (const key of members) {
        const template = tmpl.find((t) => t.key === (key === 'owner2' ? 'owner' : key))!;
        const role = await tx.organizationRole.upsert({
          where: { organizationId_key: { organizationId: org, key: template.key } },
          update: {},
          create: {
            organizationId: org,
            key: template.key,
            name: template.name,
            isSystem: template.isSystem,
          },
        });
        await tx.organizationRolePermission.createMany({
          skipDuplicates: true,
          data: template.capabilities.map((capability) => ({
            organizationId: org,
            organizationRoleId: role.id,
            capability,
            effect: 'ALLOW',
          })),
        });
        const user = await tx.user.create({
          data: {
            id: slug + '-' + key,
            organizationId: org,
            organizationRoleId: role.id,
            name: group + ' ' + key,
            email: key + '@' + group + '.example.test',
            department: 'TEAM',
            title: template.name,
            role: key.startsWith('owner') ? 'ADMIN' : 'EMPLOYEE',
            password: passwd,
          },
        });
        await tx.pharmacyBranchAssignment.create({
          data: { organizationId: org, userId: user.id, branchId: branch.id },
        });
        const staff = await tx.restaurantStaffProfile.create({
          data: { organizationId: org, userId: user.id, displayName: user.name, status: 'ACTIVE' },
        });
        await tx.restaurantOperatorCredential.create({
          data: { organizationId: org, staffProfileId: staff.id, type: 'PIN', credentialHash: pin },
        });
      }
    });
    return { slug, password, approvalPin };
  } finally {
    await db.$disconnect();
  }
}

const [group, ...members] = process.argv.slice(2);
if (!group || !members.length) throw new Error('Supply a group and its roles.');
seedReviewWorkspace(group, members).then((workspace) => console.log(JSON.stringify(workspace)));
