import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createdMatches,
  digest,
  fingerprint,
  sha256,
  stable,
  validatePlan,
  WRITER_TABLES,
  type Dataset,
  type FingerprintPlan,
} from './fresh-database-fingerprint.js';
import {
  assertFreshRuntimeRole,
  freshDatabaseIntentSha256,
  verifyFreshDatabaseSource,
  type FreshDatabaseBaseline,
  type FreshDatabaseEndpoint,
  type FreshDatabaseInput,
  type RuntimeRole,
} from './fresh-database.js';
import { schemaInventory, type Catalog } from './fresh-database-observer.js';
import { MODULE_CATALOG } from '../src/lib/module-catalog.js';
import {
  RESTAURANT_PACKAGES,
  roleTemplatesForVertical,
  defaultDepartmentRowsForVertical,
} from '../src/lib/vertical-catalog.js';

export const CONTEXT_FILES = [
  'prisma/fresh-database.ts',
  'prisma/fresh-database-bootstrap.ts',
  'prisma/production-bootstrap.ts',
  'prisma/catalog-sync.ts',
  'src/lib/module-catalog.ts',
  'src/lib/vertical-catalog.ts',
  'prisma/fresh-database-adapter.ts',
  'prisma/fresh-database-observer.ts',
  'prisma/fresh-database-fingerprint.ts',
  'prisma/fresh-database-baseline.ts',
  'prisma/fresh-database-runner.ts',
  'prisma/fresh-database-prep.ts',
  'prisma/fresh-database-migrate.config.ts',
  'prisma/tsconfig.fresh-database.json',
  'prisma/schema.prisma',
  'prisma/fresh-database-manifest.json',
  'package.json',
  'bun.lock',
] as const;
export type OfflineReview = {
  version: 'restaurant-offline-review-v1';
  provenance: 'independently-reviewed-source-effects';
  reviewId: string;
  purpose: 'INITIAL_TRANSITION' | 'COMPLETED_REPLAY';
  source: Record<string, string>;
  intentSha256: string;
  endpoint: FreshDatabaseEndpoint;
  plan: FingerprintPlan;
  initial: Dataset;
  completed: Dataset;
  catalog: Catalog;
  role: RuntimeRole & { session_user: string; database_name: string };
};
export type BaselineArtifact = {
  version: 'restaurant-baseline-v1';
  review: OfflineReview;
  baseline: FreshDatabaseBaseline;
  reviewSha256: string;
};
const fail = () => {
  throw new Error('Offline baseline review rejected.');
};

export function sourceContextPaths(root: string) {
  const migrations = verifyFreshDatabaseSource(root);
  const generated = readdirSync(join(root, 'src/generated/prisma'), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(join(root, 'src/generated/prisma').length + 1));
  if (generated.length !== 459 || generated.filter((p) => p.startsWith('models/')).length !== 451)
    return fail();
  return [
    ...CONTEXT_FILES,
    ...generated.map((p) => `src/generated/prisma/${p}`),
    ...migrations.map((p) => `prisma/migrations/${p.name}/migration.sql`),
  ];
}
export function verifySourceContext(root: string, source: Record<string, string>) {
  const paths = sourceContextPaths(root);
  if (stable(Object.keys(source).sort()) !== stable(paths.sort())) return fail();
  for (const path of paths)
    if (
      !/^[a-f0-9]{64}$/.test(source[path]) ||
      sha256(readFileSync(join(root, path))) !== source[path]
    )
      return fail();
  if (
    source['prisma/production-bootstrap.ts'] !==
    '18f9e4ff6cf1e2faeeb1e53989136ba647b4e4d85df649fd49d14b10b57ec923'
  )
    return fail();
}

export function validateEffects(review: OfflineReview, input: FreshDatabaseInput) {
  const r = input.restaurant;
  // The canonical writer is additive. Every historical row survives byte-for-byte.
  for (const table of review.plan.tables) {
    const initial = review.initial[table.name],
      completed = review.completed[table.name];
    if (!initial || !completed) return fail();
    for (const row of initial)
      if (!completed.some((next) => stable(next) === stable(row))) return fail();
    if (
      !(WRITER_TABLES as readonly string[]).includes(table.name) &&
      stable(initial.map(stable).sort()) !== stable(completed.map(stable).sort())
    )
      return fail();
  }
  if (
    !review.initial.organizations?.some((row) => row.id === 'org_devfathom') ||
    !review.initial.organization_departments?.some((row) => row.organizationId === 'org_devfathom')
  )
    return fail();
  const exactly = (table: string, id: string) => {
    const matches = review.completed[table].filter((row) => row.id === id);
    if (matches.length !== 1) return fail();
    return matches[0];
  };
  const organization = exactly('organizations', r.organizationId),
    admin = exactly('users', r.adminId),
    platform = exactly('platform_users', r.platformAdminId);
  if (
    organization.slug !== r.organizationSlug ||
    organization.legalName !== r.organizationLegalName ||
    organization.displayName !== r.organizationDisplayName ||
    organization.vertical !== 'RESTAURANT' ||
    !['false', 'f'].includes(organization.isDemo!) ||
    admin.organizationId !== r.organizationId ||
    admin.email !== r.adminEmail ||
    platform.email !== r.platformAdminEmail
  )
    return fail();
  const selectedPackage = RESTAURANT_PACKAGES.find((p) => p.key === r.packageKey)!;
  const moduleKeys = MODULE_CATALOG.filter(
    (m) => m.band === 'BASELINE' || selectedPackage.moduleKeys.includes(m.key)
  ).map((m) => m.key);
  const templates = roleTemplatesForVertical('RESTAURANT');
  for (const { rule, rows, selector } of createdMatches(review.plan, review.completed)) {
    if (
      review.initial[rule.table].some((row) =>
        Object.entries(selector).every(([k, v]) => row[k] === v)
      )
    )
      return fail();
    if (rows.length !== 1) return fail();
    const row = rows[0];
    if (row.organizationId !== undefined && row.organizationId !== r.organizationId) return fail();
    if (rule.table === 'organizations' && row.id !== r.organizationId) return fail();
    if (rule.table === 'users' && row.id !== r.adminId) return fail();
    if (rule.table === 'platform_users' && row.id !== r.platformAdminId) return fail();
    if (rule.table === 'platform_modules' && !moduleKeys.includes(row.key!)) return fail();
    if (rule.table === 'platform_packages' && row.key !== r.packageKey) return fail();
    if (rule.table === 'organization_roles' && !templates.some((t) => t.key === row.key))
      return fail();
    if (
      rule.table === 'organization_departments' &&
      !defaultDepartmentRowsForVertical('RESTAURANT').some((d) => d.key === row.key)
    )
      return fail();
    if (rule.table === 'organization_role_permissions') {
      const role = review.completed.organization_roles.find((p) => p.id === row.organizationRoleId);
      if (
        !role ||
        !templates.some(
          (t) =>
            t.key === role.key && (t.capabilities as readonly string[]).includes(row.capability!)
        ) ||
        row.effect !== 'ALLOW'
      )
        return fail();
    }
    if (rule.table === 'platform_package_modules') {
      const pkg = review.completed.platform_packages.find((p) => p.id === row.packageId);
      const module = review.completed.platform_modules.find((p) => p.id === row.moduleId);
      if (pkg?.key !== r.packageKey || !module || !selectedPackage.moduleKeys.includes(module.key!))
        return fail();
    }
    if (
      rule.password &&
      rule.selector.id !== (rule.password.secret === 'admin' ? r.adminId : r.platformAdminId)
    )
      return fail();
  }
  if (review.plan.created.some((c) => c.password)) {
    if (
      review.plan.created.filter((c) => c.password).length !== 2 ||
      admin.role !== 'ADMIN' ||
      admin.status !== 'ACTIVE' ||
      platform.role !== 'SUPER_ADMIN' ||
      !['true', 't'].includes(platform.active!) ||
      organization.status !== 'ONBOARDING'
    )
      return fail();
    const role = review.completed.organization_roles.find(
      (row) => row.id === admin.organizationRoleId
    );
    if (!role || role.key !== 'owner' || role.organizationId !== r.organizationId) return fail();
  }
}

/** Pure offline generation from explicit reviewed expected rows/effects; never receives a DB handle. */
export async function generateBaseline(
  review: OfflineReview,
  input: FreshDatabaseInput,
  root: string
): Promise<BaselineArtifact> {
  if (
    review.version !== 'restaurant-offline-review-v1' ||
    review.provenance !== 'independently-reviewed-source-effects' ||
    !review.reviewId?.trim() ||
    review.intentSha256 !== freshDatabaseIntentSha256(input) ||
    !['INITIAL_TRANSITION', 'COMPLETED_REPLAY'].includes(review.purpose)
  )
    return fail();
  verifySourceContext(root, review.source);
  validatePlan(review.plan);
  assertFreshRuntimeRole(review.role);
  if (
    review.role.session_user !== 'devfathom_app' ||
    review.role.database_name !== review.endpoint.database
  )
    return fail();
  if (
    stable(schemaInventory(root)) !==
    stable(
      review.plan.tables
        .map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name).sort() }))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
    )
  )
    return fail();
  validateEffects(review, input);
  const passwords = review.plan.created.filter((c) => c.password);
  if (
    (review.purpose === 'INITIAL_TRANSITION' && passwords.length !== 2) ||
    (review.purpose === 'COMPLETED_REPLAY' && review.plan.created.length !== 0)
  )
    return fail();
  const baseline: FreshDatabaseBaseline = {
    reviewId: review.reviewId,
    intentSha256: review.intentSha256,
    fingerprintPlanSha256: digest(review.plan),
    postureSha256: digest({
      catalog: review.catalog,
      role: review.role,
      endpoint: review.endpoint,
    }),
    initial: await fingerprint(review.plan, review.initial),
    completed: await fingerprint(review.plan, review.completed, { mode: 'OFFLINE' }),
  };
  return { version: 'restaurant-baseline-v1', review, baseline, reviewSha256: digest(review) };
}

export async function verifyBaseline(
  artifact: BaselineArtifact,
  input: FreshDatabaseInput,
  root: string
) {
  if (
    artifact.version !== 'restaurant-baseline-v1' ||
    artifact.reviewSha256 !== digest(artifact.review) ||
    stable(await generateBaseline(artifact.review, input, root)) !== stable(artifact)
  )
    return fail();
  return artifact;
}
