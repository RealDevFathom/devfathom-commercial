// Production-only, create-only bootstrap. Never use this script to reset credentials.
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import 'dotenv/config';

import { bootstrapProduction } from './production-bootstrap.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const databaseUrl = required('DATABASE_URL');
  const adminPassword = process.env.ADMIN_PASSWORD;
  const platformAdminPassword = process.env.PLATFORM_ADMIN_PASSWORD;

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    await prisma.$transaction(
      (tx) =>
        bootstrapProduction(tx, {
          organizationId:
            process.env.DEFAULT_ORGANIZATION_ID?.trim() ||
            process.env.ORGANIZATION_ID?.trim() ||
            'org_devfathom',
          adminName: process.env.ADMIN_NAME?.trim() || 'Workspace Administrator',
          adminEmail: required('ADMIN_EMAIL'),
          adminPassword,
          adminTitle: process.env.ADMIN_TITLE?.trim() || 'Administrator',
          platformAdminName: process.env.PLATFORM_ADMIN_NAME?.trim() || 'Platform Administrator',
          platformAdminEmail: required('PLATFORM_ADMIN_EMAIL'),
          platformAdminPassword,
          deploymentUrl: required('AUTH_URL'),
        }),
      { maxWait: 30_000, timeout: 300_000 }
    );
    console.log('Production database bootstrap complete.');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch(() => {
  console.error('Production database bootstrap failed.');
  process.exit(1);
});
