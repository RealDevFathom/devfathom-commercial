import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL ?? '';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaVersion: string | undefined;
};

// Version key to bust cache when schema changes
const PRISMA_VERSION = '7';

function createPrismaClient() {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

// Invalidate cached client if version changed (schema was updated)
if (globalForPrisma.prismaVersion !== PRISMA_VERSION) {
  globalForPrisma.prisma = undefined;
  globalForPrisma.prismaVersion = PRISMA_VERSION;
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db;
}
