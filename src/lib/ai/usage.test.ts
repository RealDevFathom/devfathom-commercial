import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredAISettings } from './spend';

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  execute: vi.fn(),
  session: vi.fn(),
  stored: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({ $queryRaw: mocks.raw, $executeRaw: mocks.execute }),
  withTenantDb: vi.fn(),
}));
vi.mock('@/lib/platform/auth', () => ({ requirePlatformSession: mocks.session }));
vi.mock('./spend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spend')>()),
  readStoredAISettings: mocks.stored,
}));

import {
  karachiMonth,
  maybeCreateAIBudgetAlert,
  providerCapState,
  readMonthlyAIUsage,
} from './usage';

type SqlArg = { sql: string; values: unknown[] };
const sqlOf = (mock: typeof mocks.execute, call: number) => mock.mock.calls[call]![0] as SqlArg;

function stored(capsUsd: StoredAISettings['capsUsd']): StoredAISettings {
  return {
    mode: 'Auto',
    providerOrder: [],
    fallbackEnabled: true,
    capsUsd,
    models: { anthropic: {}, openai: {}, bedrock: {} },
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    updatedBy: 'admin',
  };
}

/** One aggregate row as the report query returns it. */
function row(
  provider: string,
  tier: string,
  spendMinor: number,
  providerSpendMinor: number,
  providerSpendUsd: string,
  calls = 1
) {
  return {
    provider,
    tier,
    calls: BigInt(calls),
    inputTokens: BigInt(calls * 1_000),
    outputTokens: BigInt(calls * 100),
    spendMinor: BigInt(spendMinor),
    providerSpendMinor: BigInt(providerSpendMinor),
    providerSpendUsd,
  };
}

const NOV = new Date('2026-11-10T00:00:00Z');

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('AI_ANTHROPIC_MONTHLY_CAP_USD', '');
  vi.stubEnv('AI_OPENAI_MONTHLY_CAP_USD', '');
  vi.stubEnv('AI_BEDROCK_MONTHLY_CAP_USD', '');
  vi.stubEnv('AI_PROVIDER_ORDER', '');
  for (const provider of ['ANTHROPIC', 'OPENAI', 'BEDROCK']) {
    for (const tier of ['CHEAP', 'STANDARD', 'DEEP'])
      vi.stubEnv(`AI_${provider}_MODEL_${tier}`, '');
  }
  mocks.session.mockResolvedValue({ id: 'admin', role: 'SUPER_ADMIN' });
  mocks.stored.mockResolvedValue(null);
  mocks.execute.mockResolvedValue(0);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Asia/Karachi month', () => {
  it('uses Pakistan calendar boundaries and labels the month', () => {
    expect(karachiMonth(new Date('2026-10-31T20:00:00Z'))).toEqual({
      month: '2026-11',
      from: new Date('2026-10-31T19:00:00.000Z'),
      to: new Date('2026-11-30T19:00:00.000Z'),
    });
    expect(karachiMonth(new Date('2026-12-31T18:59:59.999Z')).month).toBe('2026-12');
    expect(karachiMonth(new Date('2026-12-31T19:00:00.000Z')).month).toBe('2027-01');
  });
});

describe('provider cap state', () => {
  it('is ok below 80%, near cap from 80% and capped at the cap, as the router skips it', () => {
    expect(providerCapState(0, 190)).toEqual({ percentUsed: 0, status: 'ok' });
    expect(providerCapState(151.99, 190).status).toBe('ok');
    expect(providerCapState(152, 190)).toEqual({ percentUsed: 80, status: 'near_cap' });
    expect(providerCapState(189.99999999, 190).status).toBe('near_cap');
    expect(providerCapState(190, 190)).toEqual({ percentUsed: 100, status: 'capped' });
    expect(providerCapState(450, 300)).toEqual({ percentUsed: 150, status: 'capped' });
  });

  it('treats a zero cap as capped, because routing never uses that provider', () => {
    expect(providerCapState(0, 0)).toEqual({ percentUsed: 100, status: 'capped' });
  });
});

describe('monthly AI usage report', () => {
  it('groups the platform ledger by provider and tier against each effective cap', async () => {
    mocks.stored.mockResolvedValue(stored({ anthropic: 15, openai: 0.012 }));
    mocks.raw.mockResolvedValue([
      // 3.2345679 + 10.005 = 13.2395679 USD: the provider total is rounded once.
      row('anthropic', 'cheap', 323, 1_324, '13.23956790', 2),
      row('anthropic', 'deep', 1_001, 1_324, '13.23956790'),
      // 0.006 + 0.006: each tier rounds up to a cent, the provider total to one cent.
      row('openai', 'deep', 1, 1, '0.01200000'),
      row('openai', 'standard', 1, 1, '0.01200000'),
      row('bedrock', 'legacy', 50, 50, '0.50000000'),
    ]);

    const usage = await readMonthlyAIUsage(NOV);

    expect(usage.month).toBe('2026-11');
    expect(usage.capSource).toBe('superadmin');
    expect(usage.providers.map((entry) => entry.provider)).toEqual([
      'anthropic',
      'openai',
      'bedrock',
    ]);
    const [anthropic, openai, bedrock] = usage.providers;
    expect(anthropic).toMatchObject({ spendMinor: 1_324, capMinor: 1_500, status: 'near_cap' });
    expect(anthropic!.percentUsed).toBeCloseTo(88.264, 2);
    expect(anthropic!.tiers).toEqual([
      {
        tier: 'cheap',
        configuredModel: 'claude-haiku-5-5',
        calls: 2,
        inputTokens: 2_000,
        outputTokens: 200,
        spendMinor: 323,
      },
      {
        tier: 'standard',
        configuredModel: 'claude-sonnet-5-5',
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        spendMinor: 0,
      },
      {
        tier: 'deep',
        configuredModel: 'claude-opus-5-5',
        calls: 1,
        inputTokens: 1_000,
        outputTokens: 100,
        spendMinor: 1_001,
      },
    ]);
    // Capped on the exact sum, as the router decides, not on the rounded cents.
    expect(openai).toMatchObject({ spendMinor: 1, capMinor: 1, status: 'capped' });
    expect(openai!.tiers.map((tier) => [tier.tier, tier.spendMinor])).toEqual([
      ['cheap', 0],
      ['standard', 1],
      ['deep', 1],
    ]);
    // Bedrock keeps its environment default cap; an unknown ledger tier sorts last.
    expect(bedrock).toMatchObject({ spendMinor: 50, capMinor: 30_000, status: 'ok' });
    expect(bedrock!.tiers.at(-1)).toMatchObject({ tier: 'legacy', configuredModel: null });
    expect(usage.totalSpendMinor).toBe(1_375);
  });

  it('reads only the platform ledger for the Karachi month', async () => {
    mocks.raw.mockResolvedValue([]);
    await readMonthlyAIUsage(NOV);
    const query = mocks.raw.mock.calls[0]![0] as SqlArg;
    expect(query.sql).toContain('FROM "ai_provider_usage"');
    expect(query.sql).not.toMatch(/"ai_usage"/);
    expect(query.values).toEqual([
      new Date('2026-10-31T19:00:00.000Z'),
      new Date('2026-11-30T19:00:00.000Z'),
    ]);
  });

  it('reports every provider at zero with the default caps before anything is saved', async () => {
    mocks.raw.mockResolvedValue([]);
    const usage = await readMonthlyAIUsage(NOV);
    expect(usage.capSource).toBe('environment');
    expect(usage.nearCapPercent).toBe(80);
    expect(usage.totalSpendMinor).toBe(0);
    expect(
      usage.providers.map(({ provider, capMinor, percentUsed, status }) => ({
        provider,
        capMinor,
        percentUsed,
        status,
      }))
    ).toEqual([
      { provider: 'anthropic', capMinor: 19_000, percentUsed: 0, status: 'ok' },
      { provider: 'openai', capMinor: 19_000, percentUsed: 0, status: 'ok' },
      { provider: 'bedrock', capMinor: 30_000, percentUsed: 0, status: 'ok' },
    ]);
  });

  it('uses environment caps and logs only the error class when settings are unreadable', async () => {
    vi.stubEnv('AI_OPENAI_MONTHLY_CAP_USD', '20');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.stored.mockRejectedValue(new Error('relation "ai_settings" does not exist sk-secret'));
    mocks.raw.mockResolvedValue([row('openai', 'cheap', 1_900, 1_900, '19.00000000')]);

    const usage = await readMonthlyAIUsage(NOV);

    expect(usage.capSource).toBe('environment');
    expect(usage.providers[1]).toMatchObject({ capMinor: 2_000, status: 'near_cap' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('sk-secret');
  });

  it('forbids non-SuperAdmins before reading usage or settings', async () => {
    mocks.session.mockResolvedValue({ id: 'ops', role: 'OPERATIONS' });
    await expect(readMonthlyAIUsage()).rejects.toMatchObject({ status: 403 });
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.stored).not.toHaveBeenCalled();
  });

  it('accepts an already authenticated SuperAdmin identity without a session lookup', async () => {
    mocks.raw.mockResolvedValue([]);
    await readMonthlyAIUsage(NOV, { id: 'admin', role: 'SUPER_ADMIN' } as never);
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it('rejects unsafe database minor units instead of rounding them', async () => {
    mocks.raw.mockResolvedValue([
      {
        ...row('anthropic', 'cheap', 0, 0, '1'),
        spendMinor: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
      },
    ]);
    await expect(readMonthlyAIUsage(NOV)).rejects.toThrow('outside the safe minor-unit range');
  });
});

describe('per-provider cap alerts', () => {
  const spend = (usd: string) => mocks.raw.mockResolvedValue([{ total: usd }]);

  it('does nothing below 80% of the provider cap', async () => {
    spend('151.99');
    await expect(maybeCreateAIBudgetAlert('anthropic', NOV)).resolves.toBe('none');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('reads the spend of that provider only, from the platform ledger', async () => {
    spend('0');
    await maybeCreateAIBudgetAlert('openai', NOV);
    const query = mocks.raw.mock.calls[0]![0] as SqlArg;
    expect(query.sql).toContain('FROM "ai_provider_usage"');
    expect(query.values).toEqual([
      'openai',
      new Date('2026-10-31T19:00:00.000Z'),
      new Date('2026-11-30T19:00:00.000Z'),
    ]);
  });

  it('claims the provider and month and notifies every active SuperAdmin at 80%', async () => {
    spend('152');
    mocks.execute.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await expect(maybeCreateAIBudgetAlert('anthropic', NOV)).resolves.toBe('near_cap');

    const claim = sqlOf(mocks.execute, 0);
    expect(claim.sql).toContain('INSERT INTO "ai_budget_alert_months"');
    expect(claim.sql).toContain('ON CONFLICT ("provider", "month") DO NOTHING');
    expect(claim.values.slice(0, 2)).toEqual(['anthropic', '2026-11']);
    const fanOut = sqlOf(mocks.execute, 1);
    expect(fanOut.sql).toContain('INSERT INTO "platform_notifications"');
    expect(fanOut.sql).toContain(`"role" = 'SUPER_ADMIN' AND "active" = true`);
    expect(fanOut.sql).toContain(`'ai_cap_near'`);
    expect(fanOut.values).toEqual(
      expect.arrayContaining([
        'Anthropic AI spend at 80% of cap',
        expect.stringContaining('$152.00 of its $190.00 monthly cap for 2026-11'),
      ])
    );
  });

  it('alerts once per provider and month, and again next month', async () => {
    spend('160');
    mocks.execute
      .mockResolvedValueOnce(1) // November claim
      .mockResolvedValueOnce(2) // fan-out
      .mockResolvedValueOnce(0) // November already claimed
      .mockResolvedValueOnce(1) // December claim
      .mockResolvedValueOnce(2);

    await expect(maybeCreateAIBudgetAlert('anthropic', NOV)).resolves.toBe('near_cap');
    await expect(
      maybeCreateAIBudgetAlert('anthropic', new Date('2026-11-20T00:00:00Z'))
    ).resolves.toBe('none');
    await expect(
      maybeCreateAIBudgetAlert('anthropic', new Date('2026-12-05T00:00:00Z'))
    ).resolves.toBe('near_cap');

    expect(mocks.execute).toHaveBeenCalledTimes(5);
    expect(sqlOf(mocks.execute, 3).values.slice(0, 2)).toEqual(['anthropic', '2026-12']);
  });

  it('lets only one of two racing calls fan out', async () => {
    spend('160');
    let claimed = false;
    mocks.execute.mockImplementation(async (query: SqlArg) => {
      if (!query.sql.includes('"ai_budget_alert_months"')) return 2;
      if (claimed) return 0;
      claimed = true;
      return 1;
    });

    const results = await Promise.all([
      maybeCreateAIBudgetAlert('anthropic', NOV),
      maybeCreateAIBudgetAlert('anthropic', NOV),
    ]);

    expect(results.sort()).toEqual(['near_cap', 'none']);
    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });

  it('uses each provider’s own effective cap', async () => {
    mocks.stored.mockResolvedValue(stored({ openai: 50 }));
    spend('45');
    mocks.execute.mockResolvedValue(1);

    await expect(maybeCreateAIBudgetAlert('openai', NOV)).resolves.toBe('near_cap');
    await expect(maybeCreateAIBudgetAlert('bedrock', NOV)).resolves.toBe('none');
    expect(sqlOf(mocks.execute, 1).values).toContain('OpenAI AI spend at 90% of cap');
  });

  it('sends a distinct cap-reached notice at 100%, written once per SuperAdmin', async () => {
    spend('300.01');
    mocks.execute
      .mockResolvedValueOnce(1) // claim taken with the cap notice
      .mockResolvedValueOnce(2) // cap notice for two SuperAdmins
      .mockResolvedValueOnce(0) // claim exists
      .mockResolvedValueOnce(0); // every cap notice id exists

    await expect(maybeCreateAIBudgetAlert('bedrock', NOV)).resolves.toBe('cap_reached');
    await expect(maybeCreateAIBudgetAlert('bedrock', NOV)).resolves.toBe('none');

    const notice = sqlOf(mocks.execute, 1);
    expect(notice.sql).toContain(`'ai_cap_reached'`);
    expect(notice.sql).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(notice.values).toEqual(
      expect.arrayContaining([
        'ai_cap_reached:bedrock:2026-11:',
        'Amazon Bedrock AI cap reached',
        expect.stringContaining('routing skips this provider'),
      ])
    );
    // No separate 80% notice when the cap is already reached.
    expect(
      mocks.execute.mock.calls.some(([query]) => (query as SqlArg).sql.includes("'ai_cap_near'"))
    ).toBe(false);
  });

  it('still sends the cap-reached notice after the 80% alert was claimed earlier', async () => {
    spend('190');
    mocks.execute.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    await expect(maybeCreateAIBudgetAlert('anthropic', NOV)).resolves.toBe('cap_reached');
  });

  it('never throws into the router and logs only the provider and error class', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.raw.mockRejectedValue(new Error('connection refused for postgres://user:pw@db'));
    await expect(maybeCreateAIBudgetAlert('anthropic', NOV)).resolves.toBe('none');

    spend('160');
    mocks.execute.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('fan-out failed'));
    await expect(maybeCreateAIBudgetAlert('anthropic', NOV)).resolves.toBe('none');

    expect(log).toHaveBeenCalledWith('[ai-usage] could not evaluate the AI cap alert', {
      provider: 'anthropic',
      error: 'Error',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('pw@db');
  });

  it('evaluates against environment caps when settings are unreadable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.stored.mockRejectedValue(new Error('settings unavailable'));
    spend('240');
    mocks.execute.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    await expect(maybeCreateAIBudgetAlert('bedrock', NOV)).resolves.toBe('near_cap');
  });

  it('ignores a provider that is not routed', async () => {
    await expect(maybeCreateAIBudgetAlert('azure' as never, NOV)).resolves.toBe('none');
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
