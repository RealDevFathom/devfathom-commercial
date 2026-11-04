import {
  quoteIdentifier,
  validatePlan,
  WRITER_TABLES,
  type FingerprintPlan,
} from './fresh-database-fingerprint.js';

// Explicit create data plus Prisma/schema defaults; runtime query-shape tests pin this list.
export const WRITER_INSERT_COLUMNS: Record<(typeof WRITER_TABLES)[number], string[]> = {
  platform_modules: [
    'id',
    'key',
    'name',
    'category',
    'routePrefix',
    'band',
    'vertical',
    'active',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  platform_packages: [
    'id',
    'key',
    'name',
    'vertical',
    'version',
    'active',
    'defaultSeats',
    'createdAt',
    'updatedAt',
  ],
  platform_package_modules: ['id', 'packageId', 'moduleId', 'enabled', 'limits'],
  organizations: [
    'id',
    'slug',
    'legalName',
    'displayName',
    'vertical',
    'status',
    'deploymentMode',
    'packageId',
    'timezone',
    'locale',
    'currency',
    'seatLimit',
    'isDemo',
    'askFathomEnabled',
    'aiDeepStrategyEnabled',
    'gracePeriodDays',
    'createdAt',
    'updatedAt',
  ],
  organization_departments: [
    'id',
    'organizationId',
    'key',
    'name',
    'active',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  organization_roles: ['id', 'organizationId', 'key', 'name', 'isSystem', 'createdAt', 'updatedAt'],
  organization_role_permissions: [
    'id',
    'organizationId',
    'organizationRoleId',
    'capability',
    'effect',
    'createdAt',
  ],
  organization_brands: [
    'id',
    'organizationId',
    'primaryColor',
    'accentColor',
    'createdAt',
    'updatedAt',
  ],
  users: [
    'id',
    'organizationId',
    'organizationRoleId',
    'name',
    'email',
    'password',
    'role',
    'department',
    'title',
    'skills',
    'startDate',
    'status',
    'tokenVersion',
    'createdAt',
    'updatedAt',
  ],
  platform_users: [
    'id',
    'name',
    'email',
    'passwordHash',
    'role',
    'active',
    'mfaRequired',
    'createdAt',
    'updatedAt',
  ],
};

/** Offline SQL only. The deployment owner applies a reviewed plan under a separate migration identity. */
export function renderPreparation(
  plan: FingerprintPlan,
  roles: { migration: string; runtime: string },
  database: string
) {
  validatePlan(plan);
  if (
    roles.runtime !== 'devfathom_app' ||
    roles.migration === roles.runtime ||
    plan.tables.length !== 451
  )
    throw new Error('Preparation inputs rejected.');
  const runtime = quoteIdentifier(roles.runtime),
    migration = quoteIdentifier(roles.migration);
  const statements = [
    '-- REVIEW ONLY: never executed by the initializer. Existing wider grants must be separately audited/revoked.',
    '-- Migration role owns extension/migration operations; runtime role has no ownership, memberships, CREATE or TEMP.',
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${runtime};`,
    `GRANT USAGE ON SCHEMA public TO ${runtime};`,
    `GRANT SELECT ON TABLE public."_prisma_migrations" TO ${runtime};`,
    '-- Every application table needs SELECT for complete-state observation, subject to exact FORCE RLS policy review.',
    ...plan.tables.map(
      (t) => `GRANT SELECT ON TABLE public.${quoteIdentifier(t.name)} TO ${runtime};`
    ),
    '-- INSERT only on the ten canonical writer tables. No DELETE/TRUNCATE/default/blanket DML grants.',
    ...WRITER_TABLES.map((name) => {
      const table = plan.tables.find((t) => t.name === name);
      if (!table) throw new Error('Writer inventory rejected.');
      const columns = WRITER_INSERT_COLUMNS[name];
      if (columns.some((c) => !table.columns.some((column) => column.name === c)))
        throw new Error('Writer column inventory rejected.');
      return `GRANT INSERT (${columns.map(quoteIdentifier).join(', ')}) ON TABLE public.${quoteIdentifier(name)} TO ${runtime};`;
    }),
    '-- Built-in catalog reads, set_config and pg_advisory_xact_lock require their standard EXECUTE privileges.',
    '-- No sequence grants: the canonical writer uses client-generated IDs. Any future SQL needing UPDATE requires separate exact review.',
  ];
  const extensions = [
    `-- Apply as separately approved migration role ${migration}; never SET ROLE from the initializer.`,
    'CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;',
    'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;',
    '-- Review extension function ACL hardening against all 126 pinned migrations before runtime admission.',
  ];
  return { runtimeSQL: statements.join('\n') + '\n', extensionSQL: extensions.join('\n') + '\n' };
}
