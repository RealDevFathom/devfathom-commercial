/**
 * @vitest-environment node
 *
 * The SuperAdmin AI switch against a real, migrated PostgreSQL database under
 * forced RLS: what the router saves is what the AI router then routes by.
 * Requires TEST_DATABASE_URL (a NOSUPERUSER NOBYPASSRLS runtime role); skipped
 * without it.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requirePlatformSession: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/platform/auth', async () => {
  const { canPlatformRole } = await import('@/lib/platform/capabilities');
  return {
    requirePlatformSession: mocks.requirePlatformSession,
    canPlatform: (identity: { role: never; enrollmentOnly?: boolean }, capability: string) =>
      !identity.enrollmentOnly && canPlatformRole(identity.role, capability),
  };
});

import { db } from '@/lib/db';
import {
  __setRouterDependenciesForTests,
  candidateChain,
  karachiMonthBounds,
  readRoutingSettings,
} from '@/lib/ai/router';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

import { aiSettingsRouter } from './ai-settings';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const actorId = `platform_ai_settings_${suffix}`;
const usageId = `ai_settings_usage_${suffix}`;
/** A routed environment with nothing preferred, so only the saved settings steer the chain. */
const env: Record<string, string | undefined> = { NODE_ENV: 'test' };

const caller = (ctx: Record<string, unknown> = {}) => aiSettingsRouter.createCaller(ctx as never);

async function chainNow() {
  __setRouterDependenciesForTests(null);
  return candidateChain(await readRoutingSettings(env), env);
}

async function clearSettings() {
  await withPlatformDb(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM "ai_settings" WHERE "id" = 'default'`);
    await tx.$executeRawUnsafe(`DELETE FROM "ai_provider_usage" WHERE "id" = $1`, usageId);
  });
}

suite('AI settings router against PostgreSQL', () => {
  beforeAll(async () => {
    const rows = await withPlatformDb(
      (tx) =>
        tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    // The router must be exercised through RLS, not around it.
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await clearSettings();
  });

  beforeEach(() => {
    mocks.requirePlatformSession.mockResolvedValue({ id: actorId, role: 'SUPER_ADMIN' });
    __setRouterDependenciesForTests(null);
  });

  afterAll(async () => {
    __setRouterDependenciesForTests(null);
    await clearSettings();
    await db.$disconnect();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('routes by what a SUPER_ADMIN saves, and audits every save', async () => {
    // No row is seeded: the environment default order applies.
    expect(await chainNow()).toEqual(['anthropic', 'openai', 'bedrock']);
    expect((await readRoutingSettings(env)).source).toBe('environment');

    await caller().setMode({ mode: 'ForceOpenAI' });
    expect(await chainNow()).toEqual(['openai', 'anthropic', 'bedrock']);

    await caller().setProviderOrder({ providerOrder: ['bedrock', 'anthropic'] });
    expect(await chainNow()).toEqual(['openai', 'bedrock', 'anthropic']);

    await caller().setFallbackEnabled({ fallbackEnabled: false });
    expect(await chainNow()).toEqual(['openai']);

    await caller().setMonthlyCap({ provider: 'anthropic', capUsd: '12.5' });
    await caller().setTierModel({ provider: 'openai', tier: 'deep', model: 'gpt-db-deep' });
    __setRouterDependenciesForTests(null);
    const settings = await readRoutingSettings(env);
    expect(settings.capsUsd).toEqual({ anthropic: 12.5, openai: 190, bedrock: 300 });
    expect(settings.models.openai.deep).toBe('gpt-db-deep');
    expect(settings.source).toBe('superadmin');

    await caller().setMode({ mode: 'Disabled' });
    expect(await chainNow()).toEqual([]);

    await caller().reset({ scope: 'all' });
    expect(await chainNow()).toEqual(['anthropic', 'openai', 'bedrock']);
    __setRouterDependenciesForTests(null);
    expect(await readRoutingSettings(env)).toMatchObject({
      mode: 'Auto',
      fallbackEnabled: true,
      capsUsd: { anthropic: 190, openai: 190, bedrock: 300 },
      models: { openai: { deep: 'gpt-6.1-sol' } },
    });

    const audits = await withPlatformDb((tx) =>
      tx.platformAuditLog.findMany({
        where: { actorPlatformUserId: actorId, targetType: 'AISetting', targetId: 'default' },
      })
    );
    const byFields = (...fields: string[]) =>
      audits.filter(
        (row) =>
          JSON.stringify((row.metadata as { fields?: string[] } | null)?.fields) ===
          JSON.stringify(fields)
      );
    expect(audits.filter((row) => row.action === 'ai.settings.updated')).toHaveLength(6);
    expect(byFields('mode')).toHaveLength(2);
    expect(
      byFields('mode').find((row) => (row.metadata as { created?: boolean }).created)
    ).toMatchObject({
      action: 'ai.settings.updated',
      before: { mode: null },
      after: { mode: 'ForceOpenAI' },
    });
    expect(byFields('anthropicMonthlyCapUsd')).toEqual([
      expect.objectContaining({
        before: { anthropicMonthlyCapUsd: null },
        after: { anthropicMonthlyCapUsd: '12.5' },
        metadata: expect.objectContaining({ provider: 'anthropic' }),
      }),
    ]);
    const [reset] = audits.filter((row) => row.action === 'ai.settings.reset');
    expect(reset).toMatchObject({
      before: {
        mode: 'Disabled',
        providerOrder: ['bedrock', 'anthropic'],
        fallbackEnabled: false,
        deepOpenaiModel: 'gpt-db-deep',
      },
      after: { mode: 'Auto', providerOrder: [], fallbackEnabled: true, deepOpenaiModel: null },
      metadata: expect.objectContaining({ scope: 'all' }),
    });
  });

  it('takes effect once the 30 second settings cache expires', async () => {
    const start = new Date('2026-11-02T10:00:00Z');
    let now = start;
    __setRouterDependenciesForTests({ now: () => now });
    expect(candidateChain(await readRoutingSettings(env), env)[0]).toBe('anthropic');

    await caller().setMode({ mode: 'ForceBedrock' });
    now = new Date(start.getTime() + 10_000);
    expect(candidateChain(await readRoutingSettings(env), env)[0]).toBe('anthropic');
    now = new Date(start.getTime() + 30_001);
    expect(candidateChain(await readRoutingSettings(env), env)[0]).toBe('bedrock');

    await caller().reset({ scope: 'mode' });
  });

  it('rolls the setting back with its audit row when the surrounding transaction fails', async () => {
    const before = await withPlatformDb((tx) =>
      tx.platformAuditLog.count({ where: { actorPlatformUserId: actorId } })
    );
    await expect(
      withPlatformDb(async (platformDb) => {
        await caller({ platformDb }).setMode({ mode: 'Disabled' });
        throw new Error('a sibling procedure failed');
      })
    ).rejects.toThrow('a sibling procedure failed');

    expect(await chainNow()).toEqual(['anthropic', 'openai', 'bedrock']);
    expect(
      await withPlatformDb((tx) =>
        tx.platformAuditLog.count({ where: { actorPlatformUserId: actorId } })
      )
    ).toBe(before);
  });

  it('reports this month’s recorded spend against the effective cap', async () => {
    const { from } = karachiMonthBounds(new Date());
    await withPlatformDb((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "ai_provider_usage"
           ("id", "provider", "tier", "model", "feature", "inputTokens", "outputTokens", "costUsd", "createdAt")
         VALUES ($1, 'openai', 'standard', 'gpt-5.4-mini', 'test', 1, 1, 40, $2)`,
        usageId,
        new Date(Math.max(from.getTime() + 1_000, Date.now() - 1_000))
      )
    );
    await caller().setMonthlyCap({ provider: 'openai', capUsd: '40' });

    const view = await caller().get();
    const openai = view.providers.find((entry) => entry.provider === 'openai')!;
    expect(openai.spentUsd).toBeGreaterThanOrEqual(40);
    expect(openai).toMatchObject({ capUsd: 40, capIsOverride: true });
    expect(['at', 'over']).toContain(openai.capStatus);

    await caller().reset({ scope: 'cap', provider: 'openai' });
  });

  it('refuses other platform roles before touching the database', async () => {
    mocks.requirePlatformSession.mockResolvedValue({ id: actorId, role: 'OPERATIONS' });
    await expect(caller().setMode({ mode: 'Disabled' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await chainNow()).toEqual(['anthropic', 'openai', 'bedrock']);
  });
});
