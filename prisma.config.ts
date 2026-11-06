// Real environment > .env.local > .env, as in Next.js (prisma/load-env.ts).
import './prisma/load-env';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'bunx tsx prisma/seed.ts',
  },
  datasource: {
    // Migrations use the elevated URL when it is set. The running server reads
    // DATABASE_URL only (src/lib/db.ts) and must stay NOSUPERUSER NOBYPASSRLS.
    // Not required here: `prisma generate` runs without a database.
    url: process.env['MIGRATION_DATABASE_URL']?.trim() || process.env['DATABASE_URL'],
    shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'],
  },
});
