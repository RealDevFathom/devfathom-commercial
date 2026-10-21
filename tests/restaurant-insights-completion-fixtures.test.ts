import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  insightsCompletionFixtureReady,
  insightsCompletionOrigin,
  insightsCompletionPassword,
  restaurantInsightsCompletionFixture as fixture,
  type InsightsCompletionTenant,
} from './e2e/fixtures/restaurant-insights-completion';

/**
 * WHA-1553 source-level safety net for the two isolated Insights acceptance
 * tenants. It reads the seed as text rather than importing it, because the seed
 * pulls in the generated Prisma client; every check below is therefore a source
 * check and proves nothing about a real database.
 */
const seedPath = 'scripts/seed-restaurant-insights-completion-fixtures.ts';
const seed = readFileSync(resolve(process.cwd(), seedPath), 'utf8');
const caller = readFileSync(resolve(process.cwd(), 'scripts/seed-restaurant-e2e.ts'), 'utf8');

const tenants = Object.entries(fixture) as Array<[string, InsightsCompletionTenant]>;

function identityLiterals(tenant: InsightsCompletionTenant): string[] {
  return [
    tenant.organizationId,
    tenant.slug,
    tenant.displayName,
    tenant.branchId,
    tenant.branchName,
    tenant.admin.email,
    tenant.admin.userId,
    tenant.admin.staffProfileId,
  ];
}

describe('Insights completion acceptance fixture contract', () => {
  test.each(tenants)('%s identity literals are the ones the seed writes', (_key, tenant) => {
    for (const literal of identityLiterals(tenant)) {
      expect(seed, literal).toContain(`'${literal}'`);
    }
    for (const businessDate of tenant.businessDates) {
      expect(seed, businessDate).toContain(`businessDate: '${businessDate}'`);
    }
    expect(tenant.rollupCount).toBe(tenant.businessDates.length);
    expect(tenant.host).toBe(`${tenant.slug}.localhost`);
  });

  test('the two tenants share no identifier, slug, host or login', () => {
    const values = tenants.flatMap(([, tenant]) => [...identityLiterals(tenant), tenant.host]);
    expect(new Set(values).size).toBe(values.length);
  });

  test('covers the chat-off and entitlement-denied cases without confounding them', () => {
    expect(fixture.chatOff.askFathomEnabled).toBe(false);
    expect(fixture.chatOff.insightsEntitlement).toEqual({
      moduleKey: 'restaurant-insights',
      status: 'ENABLED',
      enabled: true,
    });
    expect(fixture.insightsDenied.askFathomEnabled).toBe(true);
    expect(fixture.insightsDenied.insightsEntitlement).toEqual({
      moduleKey: 'restaurant-insights',
      status: 'DISABLED',
      enabled: false,
    });
    // Everything that is not the case under test is identical, so a denial can
    // only be the withheld entitlement and a missing chat affordance can only
    // be the company flag.
    expect(fixture.chatOff.businessDates).toEqual(fixture.insightsDenied.businessDates);
    expect(fixture.chatOff.currency).toBe(fixture.insightsDenied.currency);
    expect(fixture.chatOff.rollupCount).toBe(fixture.insightsDenied.rollupCount);
  });

  test('grants both tenants the same sufficient report capabilities and branch scope', () => {
    for (const capability of [
      'reports:financial',
      'reports:operational',
      'workforce:rates',
      'restaurant:configure',
    ]) {
      expect(seed).toContain(`'${capability}'`);
    }
    expect(seed).toContain('primaryBranchId: tenant.branchId');
    expect(seed).toContain("status: 'ACTIVE'");
    // One shared capability table, so neither tenant can drift into a
    // permission difference that would explain a denial.
    expect(seed.match(/const REPORT_CAPABILITIES = \[/g)).toHaveLength(1);
    expect(seed.match(/REPORT_CAPABILITIES\.map\(/g)).toHaveLength(2);
  });

  test('fails closed against a non-test database before any write', () => {
    expect(seed).toContain(
      "import { resolveRestaurantE2eDatabaseUrl } from './restaurant-e2e-database.js'"
    );
    const body = seed.slice(
      seed.indexOf('export async function seedRestaurantInsightsCompletionFixtures')
    );
    const guard = body.indexOf('resolveRestaurantE2eDatabaseUrl();');
    const firstTransaction = body.indexOf('prisma.$transaction');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstTransaction);
  });

  test('never touches the shared base fixture, package or module catalog', () => {
    for (const forbidden of [
      'org_chai_chowk',
      'branch_restaurant_e2e',
      'RESTAURANT_E2E',
      'seedRestaurantDemoControlPlane',
      'seedRestaurantDemoTenant',
      'actorFixtureReady',
      'platformPackage',
      'platformPackageModule',
    ]) {
      expect(seed, forbidden).not.toContain(forbidden);
    }
    // The module catalog is read by key and never written.
    expect(seed).toContain('tx.platformModule.findMany');
    expect(seed).not.toMatch(/platformModule\.(?:upsert|create|update|delete)/);
  });

  test('scopes every tenant write to its own organization', () => {
    expect(seed).toMatch(/setScope\(tx, tenant\.organizationId, false\)/);
    // The platform scope is only used for the organization row, its department
    // catalog, its own entitlement overrides and the read-back verification.
    expect(seed.match(/setScope\(tx, '', true\)/g)).toHaveLength(2);
    expect(seed).toContain('organizationId: tenant.organizationId');
    expect(seed).toContain('verifyTenantIsolation');
  });

  test('keeps every upsert restorative and leaves settled money rows alone', () => {
    expect(seed).not.toMatch(/update:\s*\{\s*\}/);
    for (const model of ['restaurantDailyClose', 'labourCostFact']) {
      expect(seed).toContain(`tx.${model}.findUnique`);
      expect(seed).toContain(`tx.${model}.create`);
      expect(seed, model).not.toMatch(new RegExp(`tx\\.${model}\\.(?:upsert|update|delete)`));
    }
    // Money is written as exact two-decimal strings, never as a float.
    const money = seed.match(
      /(?:grossSales|netSales|compTotal|cashExpected|cashCounted|labourCost|labourHours): '[^']+'/g
    );
    expect(money?.length).toBeGreaterThan(0);
    for (const entry of money ?? []) expect(entry).toMatch(/: '\d+\.\d{2}'$/);
  });

  test('is registered exactly once by the restaurant E2E seed', () => {
    expect(caller).toContain(
      "import { seedRestaurantInsightsCompletionFixtures } from './seed-restaurant-insights-completion-fixtures.js';"
    );
    expect(caller.match(/seedRestaurantInsightsCompletionFixtures\(prisma\)/g)).toHaveLength(1);
    // After Chai Chowk's own verification, before the optional showcase layer.
    const invocation = caller.indexOf('seedRestaurantInsightsCompletionFixtures(prisma)');
    expect(invocation).toBeGreaterThan(
      caller.indexOf('Chai Chowk tenant-separation verification failed.')
    );
    expect(invocation).toBeLessThan(caller.indexOf("process.env.RESTAURANT_DEMO_SEED === '1'"));
  });

  test('reads the login credential at call time and reports readiness honestly', () => {
    const previous = process.env.RESTAURANT_ACTOR_ADMIN_PASSWORD;
    try {
      delete process.env.RESTAURANT_ACTOR_ADMIN_PASSWORD;
      expect(insightsCompletionPassword()).toBe('');
      expect(insightsCompletionFixtureReady()).toBe(false);
      process.env.RESTAURANT_ACTOR_ADMIN_PASSWORD = 'integrated-lane-only';
      expect(insightsCompletionPassword()).toBe('integrated-lane-only');
      expect(insightsCompletionFixtureReady()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.RESTAURANT_ACTOR_ADMIN_PASSWORD;
      else process.env.RESTAURANT_ACTOR_ADMIN_PASSWORD = previous;
    }
  });

  test('resolves each tenant origin from the lane port without leaking the other tenant', () => {
    const previousBase = process.env.PLAYWRIGHT_BASE_URL;
    const previousPort = process.env.PLAYWRIGHT_PORT;
    try {
      delete process.env.PLAYWRIGHT_BASE_URL;
      process.env.PLAYWRIGHT_PORT = '4319';
      expect(insightsCompletionOrigin(fixture.chatOff)).toBe(
        'http://insights-chat-off.localhost:4319'
      );
      expect(insightsCompletionOrigin(fixture.insightsDenied)).toBe(
        'http://insights-license-denied.localhost:4319'
      );
    } finally {
      if (previousBase === undefined) delete process.env.PLAYWRIGHT_BASE_URL;
      else process.env.PLAYWRIGHT_BASE_URL = previousBase;
      if (previousPort === undefined) delete process.env.PLAYWRIGHT_PORT;
      else process.env.PLAYWRIGHT_PORT = previousPort;
    }
  });
});
