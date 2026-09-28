/**
 * WHA-1553 — browser-side identity contract for the two isolated Insights
 * completion tenants seeded by
 * `scripts/seed-restaurant-insights-completion-fixtures.ts`.
 *
 * Restated here rather than imported so the Playwright side keeps no dependency
 * on the seed script's Prisma imports; `tests/restaurant-insights-completion-fixtures.test.ts`
 * fails the automated gate as soon as the two sides disagree.
 *
 * Nothing in this module touches `restaurant-fixture.ts`, `actorFixture` or
 * `actorFixtureReady`: the five existing Insights cases keep signing in exactly
 * as they do today.
 */

export type InsightsCompletionTenantKey = 'chatOff' | 'insightsDenied';

export type InsightsCompletionTenant = {
  /** Persisted organization row; also the RLS scope for direct tenant reads. */
  readonly organizationId: string;
  /** Resolves the tenant by host as `<slug>.localhost`. */
  readonly slug: string;
  readonly host: string;
  readonly displayName: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly admin: {
    readonly email: string;
    readonly userId: string;
    readonly staffProfileId: string;
  };
  /** `organizations.askFathomEnabled` as seeded. */
  readonly askFathomEnabled: boolean;
  /** Effective `restaurant-insights` entitlement, granted per organization. */
  readonly insightsEntitlement: {
    readonly moduleKey: 'restaurant-insights';
    readonly status: 'ENABLED' | 'DISABLED';
    readonly enabled: boolean;
  };
  /** Seeded business dates, ascending; one close, rollup and labour fact each. */
  readonly businessDates: readonly string[];
  readonly rollupCount: number;
  readonly currency: 'PKR';
};

const BUSINESS_DATES = ['2026-08-25', '2026-08-26', '2026-08-27'] as const;

export const restaurantInsightsCompletionFixture: Readonly<
  Record<InsightsCompletionTenantKey, InsightsCompletionTenant>
> = {
  chatOff: {
    organizationId: 'org_restaurant_insights_chat_off',
    slug: 'insights-chat-off',
    host: 'insights-chat-off.localhost',
    displayName: 'Insights Chat Off Café',
    branchId: 'branch_insights_chat_off',
    branchName: 'Chat Off Kitchen',
    admin: {
      email: 'insights-chat-off-admin@restaurant-e2e.test',
      userId: 'user_insights_chat_off_admin',
      staffProfileId: 'staff_insights_chat_off_admin',
    },
    askFathomEnabled: false,
    insightsEntitlement: { moduleKey: 'restaurant-insights', status: 'ENABLED', enabled: true },
    businessDates: BUSINESS_DATES,
    rollupCount: BUSINESS_DATES.length,
    currency: 'PKR',
  },
  insightsDenied: {
    organizationId: 'org_restaurant_insights_denied',
    slug: 'insights-license-denied',
    host: 'insights-license-denied.localhost',
    displayName: 'Insights Denied Café',
    branchId: 'branch_insights_denied',
    branchName: 'Denied Kitchen',
    admin: {
      email: 'insights-denied-admin@restaurant-e2e.test',
      userId: 'user_insights_denied_admin',
      staffProfileId: 'staff_insights_denied_admin',
    },
    askFathomEnabled: true,
    insightsEntitlement: { moduleKey: 'restaurant-insights', status: 'DISABLED', enabled: false },
    businessDates: BUSINESS_DATES,
    rollupCount: BUSINESS_DATES.length,
    currency: 'PKR',
  },
} as const;

/**
 * Both administrators are seeded with the integrated lane's existing admin
 * password. `restaurantE2eEnvironment` strips every `RESTAURANT_ACTOR_*` email
 * and password outside its four-name allowlist, so a dedicated variable would
 * never reach the browser process; the distinct emails above carry the
 * identity separation instead. Read at call time, never at import time.
 */
export function insightsCompletionPassword(): string {
  return process.env.RESTAURANT_ACTOR_ADMIN_PASSWORD ?? '';
}

/** False when the lane was started without the credential the seed needs. */
export function insightsCompletionFixtureReady(): boolean {
  return insightsCompletionPassword().length > 0;
}

/**
 * The tenant's own origin on the running integrated server: the lane's port
 * with the hostname swapped for the tenant host, which is how
 * `resolveOrganizationByHost` picks the organization by slug.
 */
export function insightsCompletionOrigin(tenant: InsightsCompletionTenant): string {
  const url = new URL(
    process.env.PLAYWRIGHT_BASE_URL ??
      `http://localhost:${Number(process.env.PLAYWRIGHT_PORT ?? 4319)}`
  );
  url.hostname = tenant.host;
  return url.origin;
}
