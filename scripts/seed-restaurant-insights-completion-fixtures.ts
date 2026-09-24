import { hashSync } from 'bcryptjs';

import { Prisma, type PrismaClient } from '../src/generated/prisma/client.js';
import { businessDateToUtcDate } from '../src/lib/restaurant/business-date.js';
import {
  adminDepartmentKeyForVertical,
  defaultDepartmentRowsForVertical,
} from '../src/lib/vertical-catalog.js';
import { resolveRestaurantE2eDatabaseUrl } from './restaurant-e2e-database.js';

/**
 * WHA-1553 — two isolated acceptance tenants for the Insights completion lane.
 *
 * The base Chai Chowk fixture cannot prove either of the two remaining Insights
 * cases without destroying the five cases it already carries: turning company
 * chat off there would remove the affordance every other spec sees, and
 * revoking the Insights entitlement there would break the reports the same
 * fixture exists to serve. So each case gets its own disposable organization,
 * and the shared base tenant is never read, written, or toggled from here.
 *
 *  - `chatOff`       — persisted `askFathomEnabled = false`, Restaurant
 *                      Insights entitlement ON, report capabilities granted,
 *                      an active assigned branch and populated close/report
 *                      facts. Proves Insights serves reports with no chat.
 *  - `insightsDenied` — company chat ON and exactly the same capabilities,
 *                      branch assignment and seeded facts, with only the
 *                      Restaurant Insights entitlement withheld. Nothing else
 *                      differs, so a denial here can only be the entitlement.
 *
 * Entitlements are granted per organization through `organization_modules`
 * overrides, which are tenant rows keyed by this organization's id. No platform
 * package, package-module link or module catalog row is created or mutated: the
 * catalog is read by key and the seed fails closed when it is absent.
 */

const FIXED_AT = new Date('2026-08-27T00:00:00.000Z');
/** Same deterministic CI-only salt the sibling restaurant E2E seed uses. */
const PIN_BCRYPT_SALT = '$2b$12$abcdefghijklmnopqrstuu';
const TIMEZONE = 'Asia/Karachi';
const CURRENCY = 'PKR';
const SEAT_LIMIT = 5;
const VERTICAL = 'RESTAURANT' as const;

/**
 * Both tenants' administrator signs in with the password already required by
 * the integrated lane. `restaurantE2eEnvironment` deletes every
 * `RESTAURANT_ACTOR_*_EMAIL|PASSWORD` variable outside its four-name allowlist,
 * so a dedicated credential variable would be stripped before the browser ever
 * saw it. Reusing the allowed one keeps the contract inside the existing
 * envelope; the emails below are what separates the identities.
 */
const ADMIN_PASSWORD_ENV = 'RESTAURANT_ACTOR_ADMIN_PASSWORD';

/**
 * Sufficient for every Insights read the console issues: the two report
 * capabilities the routers gate on, the labour-cost capability, and
 * `restaurant:configure`, which is what makes `restaurantStaff.listBranches`
 * return the branch the console's selector needs.
 */
const REPORT_CAPABILITIES = [
  'reports:financial',
  'reports:operational',
  'workforce:rates',
  'restaurant:configure',
] as const;

/** The module catalog keys these tenants depend on; both are read, never written. */
const CORE_MODULE_KEY = 'restaurant-core';
const INSIGHTS_MODULE_KEY = 'restaurant-insights';

/**
 * Fixed business dates, deliberately unrelated to the day the seed runs: these
 * tenants carry no drawer or terminal fixture, so nothing here may depend on
 * "today". Each date carries one close, one daily rollup projected from that
 * close, and one imported labour-cost fact.
 */
const REPORT_FACTS = [
  {
    businessDate: '2026-08-25',
    orderCount: 12,
    coverCount: 30,
    grossSales: '18000.00',
    compTotal: '250.00',
    netSales: '17750.00',
    cashExpected: '9000.00',
    cashCounted: '9000.00',
    labourHours: '96.00',
    labourCost: '28800.00',
  },
  {
    businessDate: '2026-08-26',
    orderCount: 13,
    coverCount: 32,
    grossSales: '18500.00',
    compTotal: '250.00',
    netSales: '18250.00',
    cashExpected: '9250.00',
    cashCounted: '9250.00',
    labourHours: '96.00',
    labourCost: '28800.00',
  },
  {
    businessDate: '2026-08-27',
    orderCount: 14,
    coverCount: 34,
    grossSales: '19000.00',
    compTotal: '250.00',
    netSales: '18750.00',
    cashExpected: '9500.00',
    cashCounted: '9500.00',
    labourHours: '96.00',
    labourCost: '28800.00',
  },
] as const;

const ZERO = '0.00';

export type InsightsCompletionTenantKey = 'chatOff' | 'insightsDenied';

type InsightsCompletionTenant = {
  key: InsightsCompletionTenantKey;
  prefix: string;
  organizationId: string;
  slug: string;
  legalName: string;
  displayName: string;
  branchId: string;
  branchName: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  userId: string;
  userName: string;
  email: string;
  staffProfileId: string;
  staffDisplayName: string;
  askFathomEnabled: boolean;
  insightsStatus: 'ENABLED' | 'DISABLED';
};

/**
 * The published identity contract. `tests/e2e/fixtures/restaurant-insights-completion.ts`
 * restates these values for the browser side and
 * `tests/restaurant-insights-completion-fixtures.test.ts` fails when the two
 * drift apart.
 */
export const RESTAURANT_INSIGHTS_COMPLETION_TENANTS: readonly InsightsCompletionTenant[] = [
  {
    key: 'chatOff',
    prefix: 'insights_chat_off',
    organizationId: 'org_restaurant_insights_chat_off',
    slug: 'insights-chat-off',
    legalName: 'Insights Chat Off Cafe LLC',
    displayName: 'Insights Chat Off Café',
    branchId: 'branch_insights_chat_off',
    branchName: 'Chat Off Kitchen',
    roleId: 'role_insights_chat_off_admin',
    roleKey: 'insights-chat-off-admin',
    roleName: 'Insights Chat Off Administrator',
    userId: 'user_insights_chat_off_admin',
    userName: 'Chat Off Administrator',
    email: 'insights-chat-off-admin@restaurant-e2e.test',
    staffProfileId: 'staff_insights_chat_off_admin',
    staffDisplayName: 'Chat Off Administrator',
    askFathomEnabled: false,
    insightsStatus: 'ENABLED',
  },
  {
    key: 'insightsDenied',
    prefix: 'insights_denied',
    organizationId: 'org_restaurant_insights_denied',
    slug: 'insights-license-denied',
    legalName: 'Insights Denied Cafe LLC',
    displayName: 'Insights Denied Café',
    branchId: 'branch_insights_denied',
    branchName: 'Denied Kitchen',
    roleId: 'role_insights_denied_admin',
    roleKey: 'insights-denied-admin',
    roleName: 'Insights Denied Administrator',
    userId: 'user_insights_denied_admin',
    userName: 'Denied Administrator',
    email: 'insights-denied-admin@restaurant-e2e.test',
    staffProfileId: 'staff_insights_denied_admin',
    staffDisplayName: 'Denied Administrator',
    askFathomEnabled: true,
    insightsStatus: 'DISABLED',
  },
] as const;

type Tx = Prisma.TransactionClient;

function closeId(tenant: InsightsCompletionTenant, businessDate: string): string {
  return `close_${tenant.prefix}_${businessDate}`;
}

function rollupId(tenant: InsightsCompletionTenant, businessDate: string): string {
  return `rollup_${tenant.prefix}_${businessDate}`;
}

function labourId(tenant: InsightsCompletionTenant, businessDate: string): string {
  return `labour_${tenant.prefix}_${businessDate}`;
}

function assignmentId(tenant: InsightsCompletionTenant): string {
  return `assignment_${tenant.userId}`;
}

/**
 * Every row this file writes, by table, for the isolation check below. Kept
 * beside the writers so a new writer without a manifest entry is a visible
 * omission rather than an unverified row.
 */
function ownedFixtures(
  tenant: InsightsCompletionTenant
): ReadonlyArray<readonly [string, readonly string[]]> {
  const dates = REPORT_FACTS.map((fact) => fact.businessDate);
  return [
    ['organizations', [tenant.organizationId]],
    ['organization_roles', [tenant.roleId]],
    [
      'organization_role_permissions',
      REPORT_CAPABILITIES.map((_, index) => `permission_${tenant.prefix}_${index}`),
    ],
    ['users', [tenant.userId]],
    ['restaurant_branches', [tenant.branchId]],
    ['restaurant_branch_assignments', [assignmentId(tenant)]],
    ['restaurant_staff_profiles', [tenant.staffProfileId]],
    ['restaurant_daily_closes', dates.map((date) => closeId(tenant, date))],
    ['restaurant_insight_daily_rollups', dates.map((date) => rollupId(tenant, date))],
    ['restaurant_labour_cost_facts', dates.map((date) => labourId(tenant, date))],
  ] as const;
}

async function setScope(tx: Tx, organizationId: string, platformAdmin: boolean): Promise<void> {
  await tx.$executeRawUnsafe(
    `SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', $2, true)`,
    organizationId,
    platformAdmin ? 'true' : 'false'
  );
}

/**
 * Control-plane half: the organization row itself, its department catalog (the
 * composite foreign key behind `User.department`) and the per-organization
 * entitlement overrides. `organizationId` is passed explicitly on every child
 * row because this transaction carries no tenant GUC to default from.
 */
async function seedTenantControlPlane(tx: Tx, tenant: InsightsCompletionTenant): Promise<void> {
  const modules = await tx.platformModule.findMany({
    where: { key: { in: [CORE_MODULE_KEY, INSIGHTS_MODULE_KEY] } },
    select: { id: true, key: true, active: true },
  });
  const moduleIdByKey = new Map(
    modules.filter((row) => row.active).map((row) => [row.key, row.id])
  );
  for (const key of [CORE_MODULE_KEY, INSIGHTS_MODULE_KEY]) {
    if (!moduleIdByKey.has(key)) {
      throw new Error(
        `Module catalog entry "${key}" is missing or inactive; seed the restaurant module catalog before the Insights completion fixtures.`
      );
    }
  }

  await tx.organization.upsert({
    where: { id: tenant.organizationId },
    update: {
      slug: tenant.slug,
      legalName: tenant.legalName,
      displayName: tenant.displayName,
      vertical: VERTICAL,
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
      // Entitlements come from this organization's own overrides below, never
      // from a shared package, so no package is stamped here.
      packageId: null,
      timezone: TIMEZONE,
      locale: 'en',
      currency: CURRENCY,
      seatLimit: SEAT_LIMIT,
      isDemo: false,
      askFathomEnabled: tenant.askFathomEnabled,
      gracePeriodDays: 0,
      activatedAt: FIXED_AT,
      suspendedAt: null,
      terminatedAt: null,
      purgeScheduledAt: null,
      dataResidency: null,
      primaryContactName: null,
      primaryContactEmail: null,
      notes: null,
    },
    create: {
      id: tenant.organizationId,
      slug: tenant.slug,
      legalName: tenant.legalName,
      displayName: tenant.displayName,
      vertical: VERTICAL,
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
      timezone: TIMEZONE,
      locale: 'en',
      currency: CURRENCY,
      seatLimit: SEAT_LIMIT,
      askFathomEnabled: tenant.askFathomEnabled,
      activatedAt: FIXED_AT,
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
  });

  for (const department of defaultDepartmentRowsForVertical(VERTICAL)) {
    await tx.organizationDepartment.upsert({
      where: {
        organizationId_key: { organizationId: tenant.organizationId, key: department.key },
      },
      update: department,
      create: {
        ...department,
        id: `department_${tenant.prefix}_${department.key.toLowerCase()}`,
        organizationId: tenant.organizationId,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
  }

  for (const [key, status] of [
    [CORE_MODULE_KEY, 'ENABLED' as const],
    [INSIGHTS_MODULE_KEY, tenant.insightsStatus],
  ] as const) {
    const moduleId = moduleIdByKey.get(key)!;
    await tx.organizationModule.upsert({
      where: {
        organizationId_moduleId: { organizationId: tenant.organizationId, moduleId },
      },
      update: {
        status,
        seatLimit: null,
        startsAt: FIXED_AT,
        expiresAt: null,
        // No limit overrides: the two tenants differ only in the entitlement
        // status above, so a stale override from a prior run is cleared.
        overrides: Prisma.DbNull,
        reason: 'WHA-1553 Insights completion acceptance fixture',
        changedById: null,
      },
      create: {
        id: `module_${tenant.prefix}_${key.replace(/-/g, '_')}`,
        organizationId: tenant.organizationId,
        moduleId,
        status,
        startsAt: FIXED_AT,
        reason: 'WHA-1553 Insights completion acceptance fixture',
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
  }
}

/** Tenant half: role, administrator, branch, branch-scoped staff identity. */
async function seedTenantIdentity(
  tx: Tx,
  tenant: InsightsCompletionTenant,
  passwordHash: string | null
): Promise<void> {
  const permissions = REPORT_CAPABILITIES.map((capability, index) => ({
    id: `permission_${tenant.prefix}_${index}`,
    capability,
    effect: 'ALLOW' as const,
    createdAt: FIXED_AT,
  }));
  await tx.organizationRole.upsert({
    where: { id: tenant.roleId },
    update: {
      key: tenant.roleKey,
      name: tenant.roleName,
      description: null,
      isSystem: false,
      permissions: { deleteMany: {}, create: permissions },
    },
    create: {
      id: tenant.roleId,
      key: tenant.roleKey,
      name: tenant.roleName,
      permissions: { create: permissions },
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
  });

  await tx.restaurantBranch.upsert({
    where: { id: tenant.branchId },
    update: {
      name: tenant.branchName,
      timezone: TIMEZONE,
      businessDayCutoff: '00:00',
      shiftSignInEnforced: false,
      address: null,
      active: true,
      isDefault: true,
    },
    create: {
      id: tenant.branchId,
      name: tenant.branchName,
      timezone: TIMEZONE,
      active: true,
      isDefault: true,
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
  });

  await tx.user.upsert({
    where: { id: tenant.userId },
    update: {
      organizationRoleId: tenant.roleId,
      name: tenant.userName,
      email: tenant.email,
      password: passwordHash,
      department: adminDepartmentKeyForVertical(VERTICAL),
      title: 'Administrator',
      status: 'ACTIVE',
      startDate: FIXED_AT,
      role: 'EMPLOYEE',
      lastActiveAt: null,
      tokenVersion: 0,
      passwordChangedAt: null,
    },
    create: {
      id: tenant.userId,
      organizationRoleId: tenant.roleId,
      name: tenant.userName,
      email: tenant.email,
      password: passwordHash,
      department: adminDepartmentKeyForVertical(VERTICAL),
      title: 'Administrator',
      startDate: FIXED_AT,
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
  });

  await tx.restaurantBranchAssignment.upsert({
    where: { branchId_userId: { branchId: tenant.branchId, userId: tenant.userId } },
    update: { branchId: tenant.branchId, userId: tenant.userId },
    create: {
      id: assignmentId(tenant),
      branchId: tenant.branchId,
      userId: tenant.userId,
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
  });

  await tx.restaurantStaffProfile.upsert({
    where: { id: tenant.staffProfileId },
    update: {
      userId: tenant.userId,
      displayName: tenant.staffDisplayName,
      email: null,
      primaryBranchId: tenant.branchId,
      status: 'ACTIVE',
    },
    create: {
      id: tenant.staffProfileId,
      userId: tenant.userId,
      displayName: tenant.staffDisplayName,
      primaryBranchId: tenant.branchId,
      status: 'ACTIVE',
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
  });
}

/**
 * Closes and imported labour facts are settled financial records, so they are
 * created once and left alone on rerun — the same create-if-absent treatment
 * the sibling seed gives its append-only loyalty entry. The daily rollup is a
 * projection of its close, so it is restored to the projected values instead.
 */
async function seedTenantReportFacts(tx: Tx, tenant: InsightsCompletionTenant): Promise<void> {
  for (const fact of REPORT_FACTS) {
    const businessDate = businessDateToUtcDate(fact.businessDate);
    const id = closeId(tenant, fact.businessDate);
    const existing = await tx.restaurantDailyClose.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      await tx.restaurantDailyClose.create({
        data: {
          id,
          branchId: tenant.branchId,
          businessDate,
          cutByStaffProfileId: tenant.staffProfileId,
          deviceId: null,
          grossSales: fact.grossSales,
          netSales: fact.netSales,
          compTotal: fact.compTotal,
          tipTotal: ZERO,
          discountTotal: ZERO,
          refundTotal: ZERO,
          voidTotal: ZERO,
          taxTotal: ZERO,
          serviceChargeTotal: ZERO,
          deliveryFeeSales: ZERO,
          deliveryFeeRefunds: ZERO,
          cashExpected: fact.cashExpected,
          cashCounted: fact.cashCounted,
          cashVariance: ZERO,
          createdAt: FIXED_AT,
        },
      });
    }

    await tx.insightDailyRollup.upsert({
      where: { id: rollupId(tenant, fact.businessDate) },
      update: {
        branchId: tenant.branchId,
        businessDate,
        sourceDailyCloseId: id,
        orderCount: fact.orderCount,
        coverCount: fact.coverCount,
        grossSales: fact.grossSales,
        netSales: fact.netSales,
        compTotal: fact.compTotal,
        refundTotal: ZERO,
        voidTotal: ZERO,
        deliveryFeeSales: ZERO,
        deliveryFeeRefunds: ZERO,
        drawerVariance: ZERO,
        loyaltyLiability: ZERO,
        projectionVersion: 1,
        computedAt: FIXED_AT,
      },
      create: {
        id: rollupId(tenant, fact.businessDate),
        branchId: tenant.branchId,
        businessDate,
        sourceDailyCloseId: id,
        orderCount: fact.orderCount,
        coverCount: fact.coverCount,
        grossSales: fact.grossSales,
        netSales: fact.netSales,
        compTotal: fact.compTotal,
        computedAt: FIXED_AT,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });

    const labour = labourId(tenant, fact.businessDate);
    const importedLabour = await tx.labourCostFact.findUnique({
      where: { id: labour },
      select: { id: true },
    });
    if (!importedLabour) {
      await tx.labourCostFact.create({
        data: {
          id: labour,
          branchId: tenant.branchId,
          businessDate,
          labourHours: fact.labourHours,
          labourCost: fact.labourCost,
          source: 'WHA1553_FIXTURE_IMPORT',
          idempotencyKey: `wha1553-labour-${tenant.prefix}-${fact.businessDate}`,
          importedAt: FIXED_AT,
          createdAt: FIXED_AT,
        },
      });
    }
  }
}

/**
 * Reads every row back under the platform scope and rejects the seed unless
 * each one carries the organization id of the tenant that owns it. This is the
 * check that would catch a row written while the wrong tenant GUC was in force.
 */
async function verifyTenantIsolation(tx: Tx): Promise<number> {
  let verified = 0;
  for (const tenant of RESTAURANT_INSIGHTS_COMPLETION_TENANTS) {
    for (const [table, ids] of ownedFixtures(tenant)) {
      const column = table === 'organizations' ? 'id' : '"organizationId"';
      const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; organizationId: string }>>(
        `SELECT id, ${column} AS "organizationId" FROM ${table} WHERE id IN (${placeholders})`,
        ...ids
      );
      if (rows.length !== ids.length || new Set(rows.map((row) => row.id)).size !== ids.length) {
        throw new Error(
          `Insights completion fixture ${table} holds ${rows.length} of ${ids.length} expected rows for ${tenant.organizationId}.`
        );
      }
      const foreign = rows.filter((row) => row.organizationId !== tenant.organizationId);
      if (foreign.length > 0) {
        throw new Error(
          `Insights completion fixture ${table} leaked ${foreign.length} rows outside ${tenant.organizationId}.`
        );
      }
      verified += rows.length;
    }

    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: tenant.organizationId },
      select: { askFathomEnabled: true, vertical: true, status: true },
    });
    if (
      organization.askFathomEnabled !== tenant.askFathomEnabled ||
      organization.vertical !== VERTICAL ||
      organization.status !== 'ACTIVE'
    ) {
      throw new Error(
        `Insights completion tenant ${tenant.organizationId} did not persist its chat, vertical and lifecycle contract.`
      );
    }

    const insights = await tx.organizationModule.findFirst({
      where: { organizationId: tenant.organizationId, module: { key: INSIGHTS_MODULE_KEY } },
      select: { status: true, expiresAt: true },
    });
    if (!insights || insights.status !== tenant.insightsStatus || insights.expiresAt !== null) {
      throw new Error(
        `Insights completion tenant ${tenant.organizationId} did not persist ${INSIGHTS_MODULE_KEY} as ${tenant.insightsStatus}.`
      );
    }
  }
  return verified;
}

export type InsightsCompletionSeedSummary = {
  tenants: number;
  verifiedRows: number;
  reportDates: number;
  loginable: boolean;
};

/**
 * Seeds both acceptance tenants. Idempotent: rerunning restores every mutable
 * value and leaves the settled financial rows exactly as they were.
 *
 * The caller has already resolved the disposable database, but the guard is
 * re-run here so this function cannot be pointed at a non-test database by a
 * future caller. It performs no environment mutation and no schema work.
 */
export async function seedRestaurantInsightsCompletionFixtures(
  prisma: PrismaClient
): Promise<InsightsCompletionSeedSummary> {
  resolveRestaurantE2eDatabaseUrl();

  const password = process.env[ADMIN_PASSWORD_ENV];
  const passwordHash = password ? hashSync(password, PIN_BCRYPT_SALT) : null;

  await prisma.$transaction(async (tx) => {
    await setScope(tx, '', true);
    for (const tenant of RESTAURANT_INSIGHTS_COMPLETION_TENANTS) {
      await seedTenantControlPlane(tx, tenant);
    }
  });

  for (const tenant of RESTAURANT_INSIGHTS_COMPLETION_TENANTS) {
    await prisma.$transaction(
      async (tx) => {
        await setScope(tx, tenant.organizationId, false);
        await seedTenantIdentity(tx, tenant, passwordHash);
        await seedTenantReportFacts(tx, tenant);
      },
      { timeout: 30_000 }
    );
  }

  const verifiedRows = await prisma.$transaction(async (tx) => {
    await setScope(tx, '', true);
    return verifyTenantIsolation(tx);
  });

  return {
    tenants: RESTAURANT_INSIGHTS_COMPLETION_TENANTS.length,
    verifiedRows,
    reportDates: REPORT_FACTS.length,
    loginable: passwordHash !== null,
  };
}
