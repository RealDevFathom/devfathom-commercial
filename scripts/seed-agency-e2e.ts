import { PrismaPg } from '@prisma/adapter-pg';
import { hashSync } from 'bcryptjs';
import 'dotenv/config';
import pg from 'pg';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { moduleDefinitionForKey } from '../src/lib/module-catalog.js';
import { AGENCY_E2E } from '../tests/agency-e2e/agency-fixture.js';
import { resolveAgencyE2eDatabaseUrl } from './agency-e2e-environment.js';

const FIXED_AT = new Date('2026-08-30T00:00:00.000Z');
const MEETING_START = new Date('2030-09-03T10:00:00.000Z');
const MEETING_END = new Date('2030-09-03T10:30:00.000Z');
const MODULES = [
  ['dashboard', 'Dashboard', 'Core', '/dashboard', true],
  ['projects', 'Projects', 'Delivery', '/projects', true],
  ['clients', 'Clients', 'Delivery', '/clients', true],
  ['finance', 'Finance', 'Operations', '/finance', true],
  ['meetings', 'Meetings', 'Collaboration', '/meetings', true],
  ['notes', 'Notes', 'Knowledge', '/notes', true],
  ['hr', 'HR', 'People', '/hr', true],
  ['reviews', 'Performance reviews', 'People', '/reviews', true],
  ['api', 'API access', 'Developer', '/organization/api', false],
  ['webhooks', 'Webhooks', 'Developer', '/organization/webhooks', false],
] as const;

const databaseUrl = resolveAgencyE2eDatabaseUrl();
const pool = new pg.Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function seedOrganization(
  organizationId: string,
  slug: string,
  displayName: string,
  userId: string,
  email: string,
  passwordHash: string,
  packageId: string
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.is_platform_admin', 'true', true), set_config('app.current_organization_id', $1, true)`,
      organizationId
    );
    await tx.organization.upsert({
      where: { id: organizationId },
      update: {
        slug,
        legalName: displayName,
        displayName,
        vertical: 'AGENCY',
        status: 'ACTIVE',
        packageId,
        timezone: 'UTC',
        currency: 'USD',
        seatLimit: 10,
        activatedAt: FIXED_AT,
      },
      create: {
        id: organizationId,
        slug,
        legalName: displayName,
        displayName,
        vertical: 'AGENCY',
        status: 'ACTIVE',
        packageId,
        timezone: 'UTC',
        currency: 'USD',
        seatLimit: 10,
        activatedAt: FIXED_AT,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    await tx.organizationDepartment.upsert({
      where: { organizationId_key: { organizationId, key: 'LEADERSHIP' } },
      update: { name: 'Leadership', active: true, sortOrder: 0 },
      create: {
        id: `department_${organizationId}_leadership`,
        organizationId,
        key: 'LEADERSHIP',
        name: 'Leadership',
        sortOrder: 0,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    const roleId =
      organizationId === AGENCY_E2E.organizationId
        ? AGENCY_E2E.roleId
        : 'role_agency_e2e_alternate_admin_owned';
    await tx.organizationRole.upsert({
      where: { id: roleId },
      update: { key: 'administrator', name: 'Administrator', isSystem: true },
      create: {
        id: roleId,
        organizationId,
        key: 'administrator',
        name: 'Administrator',
        isSystem: true,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    await tx.user.upsert({
      where: { id: userId },
      update: {
        organizationId,
        organizationRoleId: roleId,
        name: 'Agency Gate Admin',
        email,
        password: passwordHash,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: 'Agency Administrator',
        status: 'ACTIVE',
      },
      create: {
        id: userId,
        organizationId,
        organizationRoleId: roleId,
        name: 'Agency Gate Admin',
        email,
        password: passwordHash,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: 'Agency Administrator',
        status: 'ACTIVE',
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
  });
}

async function main() {
  try {
    const [role] = await prisma.$queryRaw<
      Array<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (!role?.rolcanlogin || role.rolsuper || role.rolbypassrls) {
      throw new Error('Agency E2E seed requires LOGIN NOSUPERUSER NOBYPASSRLS.');
    }

    const email = process.env.AGENCY_E2E_ADMIN_EMAIL!.trim().toLowerCase();
    const passwordHash = hashSync(process.env.AGENCY_E2E_ADMIN_PASSWORD!, 10);
    let packageId = 'package_agency_e2e_owned';
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_platform_admin', 'true', true), set_config('app.current_organization_id', '', true)`
      );
      const suite = await tx.platformPackage.upsert({
        where: { id: packageId },
        update: {
          key: 'agency-e2e-owned',
          name: 'Agency E2E Owned',
          vertical: 'AGENCY',
          active: true,
        },
        create: {
          id: packageId,
          key: 'agency-e2e-owned',
          name: 'Agency E2E Owned',
          vertical: 'AGENCY',
          active: true,
          defaultSeats: 10,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      packageId = suite.id;
      for (const [key, name, category, routePrefix, enabled] of MODULES) {
        // `band` and the owning vertical are required registry facts, read from
        // the module catalog so this fixture cannot register a row the catalog
        // disagrees with.
        const definition = moduleDefinitionForKey(key);
        if (!definition) throw new Error(`Unknown module key: ${key}`);
        const catalogModule = await tx.platformModule.upsert({
          where: { key },
          update: { name, category, routePrefix, active: true },
          create: {
            id: `module_agency_e2e_${key}`,
            key,
            name,
            category,
            routePrefix,
            band: definition.band,
            vertical: definition.vertical,
            active: true,
            createdAt: FIXED_AT,
            updatedAt: FIXED_AT,
          },
        });
        await tx.platformPackageModule.upsert({
          where: { packageId_moduleId: { packageId, moduleId: catalogModule.id } },
          update: { enabled },
          create: {
            id: `package_module_agency_e2e_${key}`,
            packageId,
            moduleId: catalogModule.id,
            enabled,
          },
        });
      }

      const notesLicense = await tx.platformPackageModule.findFirst({
        where: { packageId, module: { key: 'notes' } },
        select: { enabled: true },
      });
      if (!notesLicense?.enabled) {
        throw new Error('Agency E2E package must license Notes.');
      }
    });

    await seedOrganization(
      AGENCY_E2E.organizationId,
      'agency-e2e-owned',
      'Northstar Agency E2E',
      AGENCY_E2E.adminId,
      email,
      passwordHash,
      packageId
    );
    await seedOrganization(
      AGENCY_E2E.alternateOrganizationId,
      'agency-e2e-alternate-owned',
      'Alternate Agency E2E',
      AGENCY_E2E.alternateAdminId,
      email,
      passwordHash,
      packageId
    );

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_platform_admin', 'false', true), set_config('app.current_organization_id', $1, true)`,
        AGENCY_E2E.organizationId
      );
      await tx.organizationRole.upsert({
        where: { id: AGENCY_E2E.customRoleId },
        update: {
          key: 'delivery-lead',
          name: 'Delivery Lead',
          description: 'Owns client delivery.',
          isSystem: false,
        },
        create: {
          id: AGENCY_E2E.customRoleId,
          organizationId: AGENCY_E2E.organizationId,
          key: 'delivery-lead',
          name: 'Delivery Lead',
          description: 'Owns client delivery.',
          isSystem: false,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      await tx.client.upsert({
        where: { id: AGENCY_E2E.clientId },
        update: {
          name: 'Atlas Labs E2E',
          industry: 'Technology',
          location: 'Remote',
          status: 'ACTIVE',
        },
        create: {
          id: AGENCY_E2E.clientId,
          name: 'Atlas Labs E2E',
          industry: 'Technology',
          location: 'Remote',
          status: 'ACTIVE',
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      await tx.project.upsert({
        where: { id: AGENCY_E2E.projectId },
        update: {
          name: 'Atlas Launch E2E',
          status: 'ACTIVE',
          type: 'CLIENT',
          clientId: AGENCY_E2E.clientId,
        },
        create: {
          id: AGENCY_E2E.projectId,
          name: 'Atlas Launch E2E',
          description: 'Owned acceptance project',
          status: 'ACTIVE',
          type: 'CLIENT',
          clientId: AGENCY_E2E.clientId,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      await tx.projectMember.upsert({
        where: {
          projectId_userId: { projectId: AGENCY_E2E.projectId, userId: AGENCY_E2E.adminId },
        },
        update: { role: 'LEAD' },
        create: {
          id: 'project_member_agency_e2e_owned',
          projectId: AGENCY_E2E.projectId,
          userId: AGENCY_E2E.adminId,
          role: 'LEAD',
        },
      });
      await tx.board.upsert({
        where: { id: AGENCY_E2E.boardId },
        update: { name: 'Delivery Board', projectId: AGENCY_E2E.projectId },
        create: {
          id: AGENCY_E2E.boardId,
          name: 'Delivery Board',
          projectId: AGENCY_E2E.projectId,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      await tx.column.upsert({
        where: { id: AGENCY_E2E.columnId },
        update: { name: 'In Progress', boardId: AGENCY_E2E.boardId, order: 0 },
        create: {
          id: AGENCY_E2E.columnId,
          name: 'In Progress',
          boardId: AGENCY_E2E.boardId,
          order: 0,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      await tx.task.upsert({
        where: { id: AGENCY_E2E.taskId },
        update: {
          title: 'Ship Agency acceptance gate',
          columnId: AGENCY_E2E.columnId,
          order: 0,
          priority: 'HIGH',
          createdById: AGENCY_E2E.adminId,
        },
        create: {
          id: AGENCY_E2E.taskId,
          title: 'Ship Agency acceptance gate',
          columnId: AGENCY_E2E.columnId,
          order: 0,
          priority: 'HIGH',
          createdById: AGENCY_E2E.adminId,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      await tx.taskAssignee.upsert({
        where: { taskId_userId: { taskId: AGENCY_E2E.taskId, userId: AGENCY_E2E.adminId } },
        update: { organizationId: AGENCY_E2E.organizationId },
        create: {
          id: 'task_assignee_agency_e2e_owned',
          taskId: AGENCY_E2E.taskId,
          userId: AGENCY_E2E.adminId,
        },
      });
      await tx.meeting.upsert({
        where: { id: AGENCY_E2E.meetingId },
        update: {
          title: 'Atlas launch review E2E',
          startTime: MEETING_START,
          endTime: MEETING_END,
          timezone: 'UTC',
          createdById: AGENCY_E2E.adminId,
        },
        create: {
          id: AGENCY_E2E.meetingId,
          title: 'Atlas launch review E2E',
          startTime: MEETING_START,
          endTime: MEETING_END,
          timezone: 'UTC',
          createdById: AGENCY_E2E.adminId,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      await tx.meetingAttendee.upsert({
        where: {
          meetingId_userId: { meetingId: AGENCY_E2E.meetingId, userId: AGENCY_E2E.adminId },
        },
        update: { joinedAt: null },
        create: {
          id: 'meeting_attendee_agency_e2e_owned',
          meetingId: AGENCY_E2E.meetingId,
          userId: AGENCY_E2E.adminId,
        },
      });
      await tx.invoice.upsert({
        where: { id: AGENCY_E2E.invoiceId },
        update: {
          invoiceNumber: 'AGENCY-E2E-001',
          clientId: AGENCY_E2E.clientId,
          projectId: AGENCY_E2E.projectId,
          items: [{ description: 'Launch delivery', quantity: 1, rate: 2500, amount: 2500 }],
          subtotal: 2500,
          tax: 0,
          total: 2500,
          currency: 'USD',
          status: 'SENT',
          dueDate: MEETING_START,
        },
        create: {
          id: AGENCY_E2E.invoiceId,
          invoiceNumber: 'AGENCY-E2E-001',
          clientId: AGENCY_E2E.clientId,
          projectId: AGENCY_E2E.projectId,
          items: [{ description: 'Launch delivery', quantity: 1, rate: 2500, amount: 2500 }],
          subtotal: 2500,
          tax: 0,
          total: 2500,
          currency: 'USD',
          status: 'SENT',
          dueDate: MEETING_START,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      await tx.transaction.upsert({
        where: { id: AGENCY_E2E.transactionId },
        update: {
          type: 'INCOME',
          amount: 2500,
          currency: 'USD',
          description: 'Atlas launch deposit E2E',
          projectId: AGENCY_E2E.projectId,
          clientId: AGENCY_E2E.clientId,
          date: FIXED_AT,
        },
        create: {
          id: AGENCY_E2E.transactionId,
          type: 'INCOME',
          amount: 2500,
          currency: 'USD',
          description: 'Atlas launch deposit E2E',
          projectId: AGENCY_E2E.projectId,
          clientId: AGENCY_E2E.clientId,
          date: FIXED_AT,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
    });
    console.log(`Agency E2E fixture restored for ${AGENCY_E2E.organizationId}.`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
