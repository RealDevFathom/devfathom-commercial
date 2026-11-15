// Production-only, create-only bootstrap. Never use this script to reset credentials.
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { loadLocalEnv } from './load-env.js';

loadLocalEnv();

import {
  bootstrapProduction,
  productionBootstrapInputFromEnvironment,
} from './production-bootstrap.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const databaseUrl = required('DATABASE_URL');
  const input = productionBootstrapInputFromEnvironment(process.env);

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    await prisma.$transaction((tx) => bootstrapProduction(tx, input), {
      maxWait: 30_000,
      timeout: 300_000,
      ...(input.mode === 'RESTAURANT' ? { isolationLevel: 'Serializable' as const } : {}),
    });
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
