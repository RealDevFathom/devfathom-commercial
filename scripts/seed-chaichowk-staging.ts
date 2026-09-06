/** Additive staging package. Never imports either disposable E2E seed executable. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { RowReference } from './chaichowk-staging-fixtures';

export type SeedTarget = {
  environment: 'staging' | 'lan' | 'disposable';
  host: string;
  port: number;
  database: string;
  organizationId: string;
  organizationSlug: string;
  vertical: 'RESTAURANT';
  branchId: string;
  branchCode: string;
  ownerUserId: string;
  email: 'owner@chaichowk.pk';
  currency: 'PKR';
  timezone: string;
  businessDate: string;
  scenarioAt: string;
  approvalReference: string;
  expiresAt: string;
};

export class SeedRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SeedRefusal';
  }
}

export function requireSeed(condition: unknown, code: string): asserts condition {
  if (!condition) throw new SeedRefusal(code);
}

const KEYS = [
  'environment',
  'host',
  'port',
  'database',
  'organizationId',
  'organizationSlug',
  'vertical',
  'branchId',
  'branchCode',
  'ownerUserId',
  'email',
  'currency',
  'timezone',
  'businessDate',
  'scenarioAt',
  'approvalReference',
  'expiresAt',
] as const;

/** Input is an owner-reviewed, non-secret target document, not discovery or provisioning. */
export function parseTarget(value: unknown, now = new Date()): SeedTarget {
  requireSeed(value && typeof value === 'object' && !Array.isArray(value), 'TARGET_REQUIRED');
  const input = value as Record<string, unknown>;
  requireSeed(
    Object.keys(input).length === KEYS.length && KEYS.every((key) => key in input),
    'TARGET_FIELDS'
  );
  for (const key of KEYS.filter((key) => key !== 'port')) {
    requireSeed(
      typeof input[key] === 'string' && input[key].length > 0 && input[key].length <= 200,
      'TARGET_FIELDS'
    );
  }
  requireSeed(
    ['staging', 'lan', 'disposable'].includes(String(input.environment)),
    'ENVIRONMENT_REQUIRED'
  );
  requireSeed(
    input.vertical === 'RESTAURANT' &&
      input.currency === 'PKR' &&
      input.email === 'owner@chaichowk.pk',
    'ACCOUNT_CLASSIFICATION'
  );
  requireSeed(
    Number.isInteger(input.port) && Number(input.port) > 0 && Number(input.port) <= 65535,
    'TARGET_PORT'
  );
  for (const key of ['organizationId', 'branchId', 'ownerUserId', 'database'] as const) {
    requireSeed(/^[a-zA-Z0-9_-]{3,128}$/.test(String(input[key])), 'TARGET_IDENTIFIER');
  }
  requireSeed(/^[a-zA-Z0-9.-]+$/.test(String(input.host)), 'TARGET_HOST');
  requireSeed(
    !/(?:^|[._-])(prod|production)(?:[._-]|$)/i.test(`${input.host}.${input.database}`),
    'PRODUCTION_FORBIDDEN'
  );
  requireSeed(/^\d{4}-\d{2}-\d{2}$/.test(String(input.businessDate)), 'BUSINESS_DATE');
  const date = new Date(`${input.businessDate}T00:00:00.000Z`);
  requireSeed(
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === input.businessDate,
    'BUSINESS_DATE'
  );
  requireSeed(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(input.scenarioAt)),
    'SCENARIO_INSTANT'
  );
  requireSeed(Number.isFinite(Date.parse(String(input.scenarioAt))), 'SCENARIO_INSTANT');
  const expiry = Date.parse(String(input.expiresAt));
  requireSeed(
    Number.isFinite(expiry) && expiry > now.getTime() && expiry - now.getTime() <= 86_400_000,
    'APPROVAL_EXPIRED_OR_TOO_LONG'
  );
  try {
    new Intl.DateTimeFormat('en', { timeZone: String(input.timezone) }).format(date);
  } catch {
    throw new SeedRefusal('TIMEZONE');
  }
  if (input.environment === 'disposable') {
    requireSeed(
      ['127.0.0.1', 'localhost'].includes(String(input.host)) &&
        ![5432, 6432, 3217, 3218].includes(Number(input.port)),
      'DISPOSABLE_LOCAL_PORT'
    );
    requireSeed(
      /^chaichowk_seed_disposable_[a-z0-9_]+$/.test(String(input.database)),
      'DISPOSABLE_DATABASE'
    );
  } else if (input.environment === 'lan') {
    requireSeed(
      input.host === '127.0.0.1' &&
        input.port === 65377 &&
        input.database === 'devfathom_win7_lan_test_20260906',
      'LAN_TARGET_REQUIRED'
    );
  } else {
    requireSeed(
      !['127.0.0.1', 'localhost'].includes(String(input.host)),
      'STAGING_TARGET_REQUIRED'
    );
  }
  return Object.fromEntries(KEYS.map((key) => [key, input[key]])) as SeedTarget;
}

export function targetDigest(target: SeedTarget): string {
  return createHash('sha256')
    .update(JSON.stringify(KEYS.map((key) => target[key])))
    .digest('hex');
}

export function seedNamespace(target: SeedTarget): string {
  return `ccdemo_v1_${createHash('sha256').update(`${target.organizationId}:${target.branchId}`).digest('hex').slice(0, 20)}_`;
}

export function validateConnection(target: SeedTarget, env: NodeJS.ProcessEnv): string {
  requireSeed(env.CHAICHOWK_SEED_DATABASE_URL, 'DATABASE_SECRET_REQUIRED');
  let url: URL;
  try {
    url = new URL(env.CHAICHOWK_SEED_DATABASE_URL);
  } catch {
    throw new SeedRefusal('DATABASE_URL_INVALID');
  }
  requireSeed(['postgres:', 'postgresql:'].includes(url.protocol), 'DATABASE_PROTOCOL');
  requireSeed(
    url.hostname === target.host &&
      Number(url.port || '5432') === target.port &&
      decodeURIComponent(url.pathname.slice(1)) === target.database,
    'TARGET_MISMATCH'
  );
  // libpq options can override startup GUCs, host/database, role, or search_path.
  requireSeed(
    [...url.searchParams.keys()].every((key) => key === 'sslmode'),
    'DATABASE_OPTIONS_FORBIDDEN'
  );
  requireSeed(url.searchParams.getAll('sslmode').length <= 1, 'DATABASE_OPTIONS_FORBIDDEN');
  requireSeed(!url.hash && Boolean(url.username), 'DATABASE_URL_INVALID');
  if (target.environment === 'staging')
    requireSeed(
      ['verify-full'].includes(url.searchParams.get('sslmode') ?? ''),
      'STAGING_TLS_REQUIRED'
    );
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL']) {
    requireSeed(!env[key] || env[key] === url.href, 'COMPETING_DATABASE_URL');
  }
  requireSeed(!env.PGOPTIONS && !env.PGSERVICE && !env.PGSERVICEFILE, 'DATABASE_OPTIONS_FORBIDDEN');
  return url.href;
}

export function parseArguments(args: string[]) {
  requireSeed(args.length === 2 || args.length === 5, 'USAGE_TARGET_OPTIONAL_APPLY_CONFIRM');
  requireSeed(args[0] === '--target' && Boolean(args[1]), 'USAGE_TARGET_OPTIONAL_APPLY_CONFIRM');
  const apply = args.length === 5;
  requireSeed(
    !apply || (args[2] === '--apply' && args[3] === '--confirm' && /^[a-f0-9]{64}$/.test(args[4]!)),
    'APPLY_CONFIRMATION_REQUIRED'
  );
  return { targetPath: args[1]!, apply, confirmation: args[4] };
}

type Permission = { capability: string; effect: string };
/** Restaurant capabilities have no static role fallback; explicit denies win. */
export function explicitCapability(role: Permission[], overrides: Permission[], action: string) {
  const matches = (rule: Permission) =>
    rule.capability === '*' ||
    rule.capability === action ||
    (rule.capability.endsWith(':*') && action.startsWith(rule.capability.slice(0, -1)));
  for (const rules of [overrides, role]) {
    const applicable = rules.filter(matches);
    if (applicable.some((rule) => rule.effect === 'DENY')) return false;
    if (applicable.some((rule) => rule.effect === 'ALLOW')) return true;
  }
  return false;
}

/** All service imports happen after target/URL validation; no dotenv or fixed credentials. */
export async function runSeed(target: SeedTarget, apply = false, confirmation?: string) {
  target = parseTarget(target);
  requireSeed(!apply || confirmation === targetDigest(target), 'APPLY_CONFIRMATION_REQUIRED');
  const databaseUrl = validateConnection(target, process.env);
  process.env.DATABASE_URL = databaseUrl;
  // Prime the app's documented process-local Prisma cache with a quiet owned client.
  // Refuse embedding in an already-running app: its connection could target another DB.
  const local = globalThis as unknown as { prisma?: unknown; prismaVersion?: string };
  requireSeed(!local.prisma, 'STANDALONE_PROCESS_REQUIRED');
  const [{ PrismaClient }, { PrismaPg }, { default: pg }] = await Promise.all([
    import('../src/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('pg'),
  ]);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  const ownedDb = new PrismaClient({ adapter: new PrismaPg(pool), log: [] });
  local.prisma = ownedDb;
  local.prismaVersion = '7';
  const [{ db }, { resolveOrganizationEntitlements }, { resolveBusinessDate }, fixtures] =
    await Promise.all([
      import('../src/lib/db'),
      import('../src/lib/entitlements'),
      import('../src/lib/restaurant/business-date'),
      import('./chaichowk-staging-fixtures'),
    ]);
  requireSeed(db === ownedDb, 'STANDALONE_PROCESS_REQUIRED');
  const namespace = seedNamespace(target);
  const receiptId = `${namespace}receipt`;
  const tombstoneId = `${namespace}tombstone`;
  const packageVersion = 'v2-integrated';
  try {
    return await db.$transaction(
      async (rawTx) => {
        if (!apply) await rawTx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await rawTx.$queryRawUnsafe(
          "SELECT set_config('app.current_organization_id', $1, true), set_config('app.current_user_id', $2, true), set_config('app.is_platform_admin', 'false', true)",
          target.organizationId,
          target.ownerUserId
        );
        // Services must reuse this transaction. No catch inside an owning transaction.
        const tx = new Proxy(rawTx, {
          get(object, key) {
            if (key === '$transaction') return (work: (inner: unknown) => unknown) => work(tx);
            if (key === '$queryRaw')
              return async (...args: unknown[]) => {
                const query = args[0] as { sql?: string };
                if (query?.sql?.includes('pg_advisory_xact_lock')) {
                  await (object.$executeRaw as (...values: unknown[]) => Promise<unknown>)(...args);
                  return [];
                }
                return (object.$queryRaw as (...values: unknown[]) => Promise<unknown>)(...args);
              };
            return Reflect.get(object, key);
          },
        }) as unknown as import('../src/lib/tenancy/scoped-db').ScopedDb;
        const [runtime] = await tx.$queryRaw<
          Array<{ rolsuper: boolean; rolbypassrls: boolean; database: string }>
        >`
        SELECT rolsuper, rolbypassrls, current_database() AS database FROM pg_roles WHERE rolname = current_user
      `;
        requireSeed(
          runtime &&
            !runtime.rolsuper &&
            !runtime.rolbypassrls &&
            runtime.database === target.database,
          'RESTRICTED_RUNTIME_REQUIRED'
        );
        const tables = await tx.$queryRaw<
          Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
        >`
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
      `;
        for (const table of fixtures.REQUIRED_RLS_TABLES) {
          requireSeed(
            tables.some(
              (row) => row.relname === table && row.relrowsecurity && row.relforcerowsecurity
            ),
            'FORCED_RLS_REQUIRED'
          );
        }
        if (apply)
          await tx.$executeRawUnsafe(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            namespace
          );
        // Different branch packages may share the same owner. Serialize the absent
        // actor prerequisite too, so they cannot create two user-linked profiles.
        if (apply)
          await tx.$executeRawUnsafe(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            `chaichowk-owner:${target.organizationId}:${target.ownerUserId}`
          );
        const organization = await tx.organization.findUnique({
          where: { id: target.organizationId },
        });
        requireSeed(
          organization &&
            organization.slug === target.organizationSlug &&
            organization.vertical === target.vertical &&
            organization.currency === target.currency &&
            organization.status === 'ACTIVE',
          'ORGANIZATION_MISMATCH'
        );
        const branch = await tx.restaurantBranch.findFirst({
          where: { id: target.branchId, organizationId: target.organizationId },
        });
        requireSeed(
          branch &&
            branch.active &&
            branch.code === target.branchCode &&
            branch.timezone === target.timezone,
          'BRANCH_MISMATCH'
        );
        requireSeed(
          resolveBusinessDate(
            new Date(target.scenarioAt),
            branch.timezone,
            branch.businessDayCutoff
          ) === target.businessDate,
          'SCENARIO_BUSINESS_DATE_MISMATCH'
        );
        const owner = await tx.user.findFirst({
          where: { organizationId: target.organizationId, email: target.email },
          select: {
            id: true,
            role: true,
            status: true,
            name: true,
            department: true,
            organizationRole: {
              select: { permissions: { select: { capability: true, effect: true } } },
            },
            permissionOverrides: {
              where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
              select: { capability: true, effect: true },
            },
          },
        });
        requireSeed(owner, 'OWNER_PROVISIONING_REQUIRED');
        requireSeed(
          owner.id === target.ownerUserId && owner.status === 'ACTIVE' && owner.role === 'ADMIN',
          'OWNER_MISMATCH'
        );
        const assigned = await tx.restaurantBranchAssignment.findFirst({
          where: { userId: owner.id, branchId: branch.id },
        });
        requireSeed(assigned, 'EXISTING_BRANCH_ASSIGNMENT_REQUIRED');
        const profiles = await tx.restaurantStaffProfile.findMany({ where: { userId: owner.id } });
        requireSeed(
          profiles.length <= 1 && profiles.every((profile) => profile.status === 'ACTIVE'),
          'OWNER_ACTOR_UNAVAILABLE'
        );
        const [
          { ensureAdministratorStaffProfile },
          { evaluateSopDepth },
          limitsApi,
          catering,
          operations,
        ] = await Promise.all([
          import('../src/lib/restaurant/administrator-staff-profile'),
          import('../src/lib/module-catalog'),
          import('../src/lib/entitlement-limits'),
          import('./chaichowk-staging-catering-fixtures'),
          import('./chaichowk-staging-operations-fixtures'),
        ]);
        const entitlements = await resolveOrganizationEntitlements(target.organizationId, tx);
        requireSeed(
          entitlements.enabledModules.includes('restaurant-core'),
          'RESTAURANT_CORE_REQUIRED'
        );
        const enabled: string[] = [];
        const gaps: string[] = [...fixtures.ALWAYS_GATED];
        for (const group of fixtures.GROUPS) {
          let allowed = group.modules.every((module) =>
            entitlements.enabledModules.includes(module)
          );
          for (const capability of group.capabilities) {
            if (
              !explicitCapability(
                owner.organizationRole?.permissions ?? [],
                owner.permissionOverrides,
                capability
              )
            )
              allowed = false;
          }
          if (allowed) enabled.push(group.key);
          else gaps.push(`${group.key}: existing module/capability gate unavailable`);
        }
        if (
          enabled.includes('operations') &&
          !operations.CHAICHOWK_OPERATIONS_REQUIRED_ACCESS.sopDepth.every(
            (depth) => evaluateSopDepth(entitlements, depth).allowed
          )
        ) {
          enabled.splice(enabled.indexOf('operations'), 1);
          gaps.push('operations: effective SOP execution/evidence/verification depth unavailable');
        }
        requireSeed(enabled.includes('catalog'), 'CATALOG_PERMISSION_REQUIRED');
        if (
          enabled.includes('orders') &&
          (await tx.restaurantPrintRoute.count({ where: { branchId: branch.id, enabled: true } }))
        ) {
          enabled.splice(enabled.indexOf('orders'), 1);
          gaps.push(
            'orders: enabled branch print routes require a separately approved simulation strategy'
          );
        }
        if (enabled.includes('billing') && !enabled.includes('orders')) {
          enabled.splice(enabled.indexOf('billing'), 1);
          gaps.push('billing: order scenarios unavailable');
        }
        // Date and enabled groups are immutable for a namespace; later approvals may renew expiry.
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify({
              packageVersion,
              organizationId: target.organizationId,
              branchId: target.branchId,
              ownerUserId: target.ownerUserId,
              businessDate: target.businessDate,
              scenarioAt: target.scenarioAt,
              timezone: target.timezone,
              enabled,
            })
          )
          .digest('hex');
        const receipt = await tx.auditLog.findUnique({ where: { id: receiptId } });
        const tombstone = await tx.auditLog.findUnique({ where: { id: tombstoneId } });
        requireSeed(Boolean(receipt) === Boolean(tombstone), 'SEED_RECEIPT_INCOMPLETE');
        if (receipt) {
          requireSeed(
            receipt.action === 'chaichowk.seed.v1' && receipt.targetId === branch.id,
            'RECEIPT_COLLISION'
          );
          const saved = receipt.metadata as {
            fingerprint?: string;
            rows?: RowReference[];
            gaps?: string[];
          } | null;
          requireSeed(
            saved?.fingerprint === fingerprint &&
              Array.isArray(saved.rows) &&
              tombstone?.action === 'chaichowk.seed.tombstone' &&
              (tombstone.metadata as { receiptHash?: string } | null)?.receiptHash ===
                fixtures.rowHash(receipt.metadata),
            'SEED_CONFIGURATION_CHANGED'
          );
          const counts = await fixtures.verifyRows(tx, saved.rows);
          return {
            mode: apply ? 'already-applied' : 'dry-run',
            confirmation: targetDigest(target),
            counts,
            gaps: saved.gaps ?? gaps,
            writes: 0,
          };
        }
        if (apply)
          await tx.$executeRawUnsafe(
            'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
            target.organizationId
          );
        if (!profiles.length) {
          const capacity = limitsApi.resolveEntitlementLimit(
            entitlements.limits,
            limitsApi.RESTAURANT_OPERATORS_LIMIT
          );
          requireSeed(
            capacity.status === 'configured' &&
              (await tx.restaurantStaffProfile.count({ where: { status: 'ACTIVE' } })) <
                capacity.value,
            'OWNER_OPERATOR_CAPACITY_REQUIRED'
          );
        }
        if (enabled.includes('operations')) {
          const capacity = limitsApi.resolveEntitlementLimit(
            entitlements.limits,
            limitsApi.SOP_TEMPLATES_LIMIT
          );
          requireSeed(
            capacity.status === 'configured' &&
              (await tx.restaurantSopTemplate.count({ where: { isActive: true } })) +
                operations.CHAICHOWK_OPERATIONS_REQUIRED_ACCESS.additionalTemplateFamilies <=
                capacity.value,
            'SOP_TEMPLATE_CAPACITY_REQUIRED'
          );
        }
        // Receipt loss with surviving deterministic rows must never look like a new seed.
        for (const table of Object.values(fixtures.MODEL_TABLES)) {
          const [row] = await tx.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM "${table}" WHERE left(id, $1) = $2`,
            namespace.length,
            namespace
          );
          requireSeed(row?.n === 0, 'UNRECEIPTED_NAMESPACE');
        }
        const context = {
          target,
          id: (key: string) => `${namespace}${key}`,
          enabled,
          ownerStaffProfileId: profiles[0]?.id ?? `${namespace}owner`,
          limits: entitlements.limits,
        };
        const plan = fixtures.planFixtures(context);
        await fixtures.assertNoCollisions(tx, plan);
        if (!apply)
          return {
            mode: 'dry-run',
            confirmation: targetDigest(target),
            plannedCounts: fixtures.planCounts(plan),
            ownerActorPrerequisite: profiles.length ? 'existing-preserved' : 'administrator-helper',
            plannedHelperScenarios: enabled.filter((group) =>
              ['catering', 'operations'].includes(group)
            ),
            plannedServiceScenarios: enabled.filter((group) =>
              ['purchasing', 'orders', 'billing'].includes(group)
            ),
            gaps,
            writes: 0,
          };
        const actor = await ensureAdministratorStaffProfile(tx, {
          organizationId: target.organizationId,
          userId: owner.id,
          displayName: owner.name,
          email: target.email,
        });
        context.ownerStaffProfileId = actor.staffProfileId;
        // Re-plan references after the established helper chooses its generated ID/default branch.
        const rows = await fixtures.seedChaichowkFixtures(
          tx,
          context,
          fixtures.planFixtures(context)
        );
        if (actor.created) rows.push({ model: 'restaurantStaffProfile', id: actor.staffProfileId });
        const helperContext = {
          organizationId: target.organizationId,
          branchId: target.branchId,
          ownerUserId: target.ownerUserId,
          businessDate: target.businessDate,
          timezone: target.timezone,
          id: context.id,
        };
        // Capture every helper create while preserving the raw transaction contract (no $transaction).
        const helperTx = new Proxy(rawTx, {
          has(object, key) {
            return key !== '$transaction' && Reflect.has(object, key);
          },
          get(object, key) {
            if (key === '$transaction') return undefined;
            const value = Reflect.get(object, key);
            if (typeof key !== 'string' || !Object.hasOwn(fixtures.MODEL_TABLES, key)) return value;
            return new Proxy(value, {
              get(model, action) {
                if (action !== 'create') return Reflect.get(model, action);
                return async (args: unknown) => {
                  const row = await model.create(args);
                  rows.push({ model: key as keyof typeof fixtures.MODEL_TABLES, id: row.id });
                  return row;
                };
              },
            });
          },
        });
        if (enabled.includes('catering')) {
          const result = await catering.seedChaichowkCateringFixtures(helperTx, helperContext);
          gaps.push(...result.gaps);
        }
        if (enabled.includes('operations')) {
          const result = await operations.seedChaichowkOperationsFixtures(helperTx, helperContext);
          gaps.push(...result.gaps);
        }
        const counts = await fixtures.verifyRows(tx, rows, true);
        await tx.auditLog.create({
          data: {
            id: receiptId,
            organizationId: target.organizationId,
            actorType: 'SYSTEM',
            source: 'SYSTEM',
            category: 'SYSTEM',
            action: 'chaichowk.seed.v1',
            targetType: 'RestaurantBranch',
            targetId: branch.id,
            description:
              'Synthetic staging fixtures; external effects suppressed; no regulatory or hardware success asserted.',
            metadata: { fingerprint, rows, gaps },
          },
        });
        await tx.auditLog.create({
          data: {
            id: tombstoneId,
            organizationId: target.organizationId,
            actorType: 'SYSTEM',
            source: 'SYSTEM',
            category: 'SYSTEM',
            action: 'chaichowk.seed.tombstone',
            targetType: 'RestaurantBranch',
            targetId: branch.id,
            description:
              'Durable synthetic namespace marker; missing receipt requires investigation, never automatic reconstruction.',
            metadata: { receiptHash: fixtures.rowHash({ fingerprint, rows, gaps }) },
          },
        });
        return { mode: 'applied', confirmation: targetDigest(target), counts, gaps };
      },
      { timeout: 120_000, maxWait: 30_000 }
    );
  } finally {
    await ownedDb.$disconnect();
    await pool.end();
    delete local.prisma;
    delete local.prismaVersion;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const args = parseArguments(process.argv.slice(2));
    const target = parseTarget(JSON.parse(await readFile(args.targetPath, 'utf8')));
    console.log(JSON.stringify(await runSeed(target, args.apply, args.confirmation)));
  })().catch((error: unknown) => {
    // Driver/service exceptions can contain parameters, hashes or connection details.
    console.error(
      JSON.stringify({ error: error instanceof SeedRefusal ? error.code : 'SEED_FAILED_REDACTED' })
    );
    process.exitCode = 1;
  });
}
