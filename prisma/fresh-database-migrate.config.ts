// Explicit migration-only context: no dotenv, seed, runtime-client substitution or execution here.
export default {
  schema: 'schema.prisma',
  migrations: { path: 'migrations' },
  datasource: { url: process.env.DATABASE_URL },
};
