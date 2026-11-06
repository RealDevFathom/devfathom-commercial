/**
 * @vitest-environment node
 *
 * DEV-576 — the per-provider spend report and cap alerts against a REAL,
 * migrated PostgreSQL: the SQL aggregation and rounding on "ai_provider_usage",
 * the Asia/Karachi month bounds, and that two concurrent alert calls produce
 * exactly one claim and one notification per active SUPER_ADMIN. The claim
 * primary key and the deterministic cap-notice ids are what make that hold, and
 * neither survives a mock.
 *
 * Requires TEST_DATABASE_URL (a migrated throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped.
 *
 * DELIBERATELY DOES NOT CALL `assertRlsEnforcingRole` (#39): nothing asserted
 * here is decided by row-level security. Every read and write goes through
 * `withPlatformDb`, and each run uses its own far-future Karachi months and its
 * own platform users, so assertions only ever see this run's rows.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

// See jobs.purge.db.test.ts: hand the adapter a connection string so the
// duplicated `pg` module under Vitest cannot break the shared client.
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 10 }),
    log: ['error'],
  }),
}));
// The report is called with an explicit identity; no session lookup happens.
vi.mock('@/lib/platform/auth', () => ({ requirePlatformSession: vi.fn() }));

const suffix = randomBytes(6).toString('hex');
const ADMIN_A = `dev576_admin_a_${suffix}`;
const ADMIN_B = `dev576_admin_b_${suffix}`;
const ADMIN_INACTIVE = `dev576_admin_off_${suffix}`;
const OPERATOR = `dev576_ops_${suffix}`;
const USERS = [ADMIN_A, ADMIN_B, ADMIN_INACTIVE, OPERATOR];

// Two distinct far-future Karachi months, so reruns and real data never collide.
const year = 3000 + (parseInt(suffix.slice(0, 6), 16) % 6000);
const REPORT_AT = new Date(Date.UTC(year, 2, 15, 12)); // March
const ALERT_AT = new Date(Date.UTC(year, 6, 15, 12)); // July

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let usage: typeof import('./usage');
let caps: Record<'anthropic' | 'openai' | 'bedrock', number>;

const ledgerIds: string[] = [];

async function ledger(
  db: ScopedDb,
  provider: string,
  tier: string,
  costUsd: string,
  createdAt: Date,
  tokens = { input: 1_000, output: 100 }
) {
  const id = `dev576_usage_${suffix}_${ledgerIds.length}`;
  ledgerIds.push(id);
  await db.$executeRawUnsafe(
    `INSERT INTO "ai_provider_usage"
       ("id", "provider", "tier", "model", "feature", "inputTokens", "outputTokens", "costUsd", "createdAt")
     VALUES ($1, $2, $3, 'test-model', 'dev576.usage-db-test', $4, $5, $6::numeric, $7)`,
    id,
    provider,
    tier,
    tokens.input,
    tokens.output,
    costUsd,
    createdAt
  );
}

/** USD with 8 decimals, as "costUsd" stores it. */
const usdText = (value: number) => value.toFixed(8);

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('AI spend report and cap alerts on PostgreSQL', () => {
  beforeAll(async () => {
    ({ withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
    usage = await import('./usage');
    const { resolveRoutingSettings } = await import('./router');
    const { readStoredAISettings } = await import('./spend');
    // Whatever this database has saved (or the environment defaults) is the policy.
    caps = resolveRoutingSettings(await readStoredAISettings()).capsUsd;

    await withPlatformDb(async (db) => {
      for (const [id, role, active] of [
        [ADMIN_A, 'SUPER_ADMIN', true],
        [ADMIN_B, 'SUPER_ADMIN', true],
        [ADMIN_INACTIVE, 'SUPER_ADMIN', false],
        [OPERATOR, 'OPERATIONS', true],
      ] as const) {
        await db.$executeRawUnsafe(
          `INSERT INTO "platform_users" ("id", "name", "email", "passwordHash", "role", "active", "updatedAt")
           VALUES ($1, $1, $2, 'not-a-real-hash', $3::"PlatformRole", $4, CURRENT_TIMESTAMP)`,
          id,
          `${id}@dev576.test`,
          role,
          active
        );
      }
    });
  }, 60_000);

  afterAll(async () => {
    if (!withPlatformDb) return;
    const months = [usage.karachiMonth(REPORT_AT).month, usage.karachiMonth(ALERT_AT).month];
    await withPlatformDb(async (db) => {
      await db.$executeRawUnsafe(
        `DELETE FROM "ai_provider_usage" WHERE "id" = ANY($1::text[])`,
        ledgerIds
      );
      await db.$executeRawUnsafe(
        `DELETE FROM "ai_budget_alert_months" WHERE "month" = ANY($1::text[])`,
        months
      );
      // Cascades to this run's notifications.
      await db.$executeRawUnsafe(
        `DELETE FROM "platform_users" WHERE "id" = ANY($1::text[])`,
        USERS
      );
    });
  }, 60_000);

  it('totals the Karachi month by provider and tier, rounding each aggregate once', async () => {
    const { from, to, month } = usage.karachiMonth(REPORT_AT);
    await withPlatformDb(async (db) => {
      await ledger(db, 'anthropic', 'cheap', '1.23456789', REPORT_AT, { input: 1_500, output: 20 });
      await ledger(db, 'anthropic', 'cheap', '2.00000001', REPORT_AT, { input: 500, output: 80 });
      await ledger(db, 'anthropic', 'deep', '10.00500000', REPORT_AT);
      await ledger(db, 'openai', 'standard', '0.00600000', REPORT_AT);
      await ledger(db, 'openai', 'deep', '0.00600000', REPORT_AT);
      // The first instant of the month is in; the first instant of the next is out.
      await ledger(db, 'bedrock', 'cheap', '0.50000000', from);
      await ledger(db, 'bedrock', 'cheap', '99.00000000', to);
      await ledger(db, 'bedrock', 'cheap', '99.00000000', new Date(from.getTime() - 1));
    });

    const report = await usage.readMonthlyAIUsage(REPORT_AT, {
      id: ADMIN_A,
      role: 'SUPER_ADMIN',
    } as never);

    expect(report.month).toBe(month);
    const [anthropic, openai, bedrock] = report.providers;
    // 3.2345679 -> 323 and 10.005 -> 1001; the provider rounds 13.2395679 once.
    expect(anthropic!.spendMinor).toBe(1_324);
    expect(anthropic!.tiers.find((tier) => tier.tier === 'cheap')).toMatchObject({
      calls: 2,
      inputTokens: 2_000,
      outputTokens: 100,
      spendMinor: 323,
    });
    expect(anthropic!.tiers.find((tier) => tier.tier === 'deep')?.spendMinor).toBe(1_001);
    expect(anthropic!.tiers.find((tier) => tier.tier === 'standard')?.calls).toBe(0);
    // Each openai tier rounds 0.006 up to a cent; the provider rounds 0.012 to one cent.
    expect(openai!.spendMinor).toBe(1);
    expect(openai!.tiers.map((tier) => tier.spendMinor)).toEqual([0, 1, 1]);
    expect(bedrock!.spendMinor).toBe(50);
    expect(bedrock!.tiers.find((tier) => tier.tier === 'cheap')?.calls).toBe(1);
    expect(report.totalSpendMinor).toBe(1_375);

    for (const entry of report.providers) {
      expect(entry.capMinor).toBe(Math.round(caps[entry.provider] * 100));
    }
    expect(anthropic!.status).toBe(usage.providerCapState(13.2395679, caps.anthropic).status);
  });

  it('creates one claim and one notification per active SuperAdmin for two racing calls', async () => {
    expect(caps.anthropic).toBeGreaterThan(0);
    const { month } = usage.karachiMonth(ALERT_AT);
    await withPlatformDb((db) =>
      ledger(db, 'anthropic', 'standard', usdText(caps.anthropic * 0.85), ALERT_AT)
    );

    const results = await Promise.all([
      usage.maybeCreateAIBudgetAlert('anthropic', ALERT_AT),
      usage.maybeCreateAIBudgetAlert('anthropic', ALERT_AT),
    ]);
    expect(results.sort()).toEqual(['near_cap', 'none']);
    // A later attempt in the same month is a no-op.
    await expect(usage.maybeCreateAIBudgetAlert('anthropic', ALERT_AT)).resolves.toBe('none');

    const { claims, perUser, activeAdmins, total } = await withPlatformDb(async (db) => {
      const [claim] = await db.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM "ai_budget_alert_months"
          WHERE "provider" = 'anthropic' AND "month" = $1`,
        month
      );
      const rows = await db.$queryRawUnsafe<Array<{ platformUserId: string; count: number }>>(
        `SELECT "platformUserId", count(*)::int AS count FROM "platform_notifications"
          WHERE "type" = 'ai_cap_near' AND "message" LIKE $1
          GROUP BY "platformUserId"`,
        `Anthropic %${month}%`
      );
      const [admins] = await db.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM "platform_users" WHERE "role" = 'SUPER_ADMIN' AND "active" = true`
      );
      return {
        claims: claim!.count,
        perUser: new Map(rows.map((row) => [row.platformUserId, row.count])),
        activeAdmins: admins!.count,
        total: rows.reduce((sum, row) => sum + row.count, 0),
      };
    });

    expect(claims).toBe(1);
    expect(perUser.get(ADMIN_A)).toBe(1);
    expect(perUser.get(ADMIN_B)).toBe(1);
    expect(perUser.has(ADMIN_INACTIVE)).toBe(false);
    expect(perUser.has(OPERATOR)).toBe(false);
    expect(total).toBe(activeAdmins);
  });

  it('sends the cap-reached notice once per active SuperAdmin when racing calls hit the cap', async () => {
    const { month } = usage.karachiMonth(ALERT_AT);
    await withPlatformDb((db) =>
      ledger(db, 'bedrock', 'deep', usdText(caps.bedrock + 0.01), ALERT_AT)
    );

    const results = await Promise.all([
      usage.maybeCreateAIBudgetAlert('bedrock', ALERT_AT),
      usage.maybeCreateAIBudgetAlert('bedrock', ALERT_AT),
    ]);
    expect(results.sort()).toEqual(['cap_reached', 'none']);

    const rows = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<{ id: string; platformUserId: string; type: string }>>(
        `SELECT "id", "platformUserId", "type" FROM "platform_notifications"
          WHERE "platformUserId" = ANY($1::text[]) AND "message" LIKE $2`,
        USERS,
        `Amazon Bedrock %${month}%`
      )
    );
    expect(rows.map((row) => row.platformUserId).sort()).toEqual([ADMIN_A, ADMIN_B].sort());
    expect(new Set(rows.map((row) => row.type))).toEqual(new Set(['ai_cap_reached']));
    expect(rows.map((row) => row.id)).toContain(`ai_cap_reached:bedrock:${month}:${ADMIN_A}`);

    const [claim] = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM "ai_budget_alert_months"
          WHERE "provider" = 'bedrock' AND "month" = $1`,
        month
      )
    );
    expect(claim!.count).toBe(1);

    const report = await usage.readMonthlyAIUsage(ALERT_AT, {
      id: ADMIN_A,
      role: 'SUPER_ADMIN',
    } as never);
    expect(report.providers.find((entry) => entry.provider === 'bedrock')?.status).toBe('capped');
    expect(report.providers.find((entry) => entry.provider === 'anthropic')?.status).toBe(
      'near_cap'
    );
  });
});
