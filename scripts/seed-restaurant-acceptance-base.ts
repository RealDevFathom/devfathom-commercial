// Fresh synthetic DB only. Reuse the normal Restaurant seed's one Agency-user prerequisite.
import { PrismaPg } from '@prisma/adapter-pg';
import { hashSync } from 'bcryptjs';
import pg from 'pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { assertAcceptanceDatabase, readAcceptanceReceipt } from './restaurant-acceptance-target';

async function main() {
  const receipt = readAcceptanceReceipt();
  const url = assertAcceptanceDatabase(process.env.DATABASE_URL, receipt);
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 20)
    throw new Error('Private ephemeral synthetic password required');
  const pool = new pg.Pool({ connectionString: url });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const identity = (
      await pool.query(
        'SELECT current_database() AS db, current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
      )
    ).rows[0];
    if (
      identity.db !== receipt.database ||
      identity.role !== receipt.runtimeRole ||
      identity.rolsuper ||
      identity.rolbypassrls
    )
      throw new Error('Restricted synthetic identity required');
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT set_config('app.current_organization_id','org_devfathom',true),set_config('app.is_platform_admin','true',true)"
      );
      const organizations = await tx.organization.findMany({
        select: { id: true, slug: true, vertical: true },
      });
      const users = await tx.user.count();
      const department = await tx.organizationDepartment.findUnique({
        where: { organizationId_key: { organizationId: 'org_devfathom', key: 'LEADERSHIP' } },
      });
      if (
        organizations.length !== 1 ||
        organizations[0]!.id !== 'org_devfathom' ||
        organizations[0]!.slug !== 'devfathom' ||
        organizations[0]!.vertical !== 'AGENCY' ||
        users !== 0 ||
        !department
      )
        throw new Error(
          'Seed base requires only the exact migration-created bootstrap organization and no users'
        );
      console.info('Synthetic seed preflight:', {
        organizations: organizations.length,
        users,
        migrationDepartment: department.key,
      });
      await tx.user.create({
        data: {
          id: 'user_acceptance_alex',
          organizationId: 'org_devfathom',
          email: 'alex@company.com',
          name: 'Synthetic Alex',
          role: 'ADMIN',
          department: 'LEADERSHIP',
          title: 'Synthetic administrator',
          password: hashSync(password, 10),
          status: 'ACTIVE',
        },
      });
    });
  } finally {
    await db.$disconnect();
    await pool.end();
  }
}
main().catch((error: unknown) => {
  console.error(
    'Synthetic base seed failed:',
    error instanceof Error ? error.message : 'Unknown error'
  );
  process.exitCode = 1;
});
