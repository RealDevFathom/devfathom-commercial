// Explicit migration-only context: no dotenv, seed, runtime-client substitution or execution here.
export default {
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
};
