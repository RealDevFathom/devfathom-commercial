import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePlatformSession: vi.fn(),
  canPlatform: vi.fn(),
  withPlatformDb: vi.fn(),
  queryRaw: vi.fn(),
  auditCreate: vi.fn(),
  settingsUpdate: vi.fn(),
  priceUpsert: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/platform/auth', () => ({
  requirePlatformSession: mocks.requirePlatformSession,
  canPlatform: mocks.canPlatform,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb,
}));

import { aiSettingsRouter } from './ai-settings';

const decimal = (value: string) => ({ toString: () => value });
const settings = {
  id: 'default',
  mode: 'Auto',
  monthlyAnthropicBudgetUsd: decimal('200'),
  cheapAnthropicModel: 'haiku',
  standardAnthropicModel: 'sonnet',
  deepAnthropicModel: 'opus',
  cheapBedrockModel: 'bedrock-haiku',
  standardBedrockModel: 'bedrock-sonnet',
  deepBedrockModel: 'bedrock-opus',
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  updatedBy: null,
};

const db = {
  $queryRawUnsafe: mocks.queryRaw,
  aISetting: {
    findUniqueOrThrow: vi.fn(async () => settings),
    update: mocks.settingsUpdate,
  },
  aIModelPrice: {
    findMany: vi.fn(async () => []),
    findUnique: vi.fn(async () => null),
    upsert: mocks.priceUpsert,
  },
  platformAuditLog: { create: mocks.auditCreate },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformSession.mockResolvedValue({ id: 'platform_super', role: 'SUPER_ADMIN' });
  mocks.canPlatform.mockReturnValue(true);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.withPlatformDb.mockImplementation(async (run: (database: typeof db) => unknown) => run(db));
  mocks.settingsUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...settings,
    ...data,
    monthlyAnthropicBudgetUsd:
      typeof data.monthlyAnthropicBudgetUsd === 'string'
        ? decimal(String(data.monthlyAnthropicBudgetUsd))
        : settings.monthlyAnthropicBudgetUsd,
  }));
  mocks.auditCreate.mockResolvedValue({ id: 'audit_1' });
});

describe('AI settings SuperAdmin boundary', () => {
  it('allows a SuperAdmin to read and update settings', async () => {
    const caller = aiSettingsRouter.createCaller({} as never);
    await expect(caller.get()).resolves.toMatchObject({
      mode: 'Auto',
      monthlyAnthropicBudgetUsd: '200',
    });
    await expect(caller.updateMode({ mode: 'Disabled' })).resolves.toMatchObject({
      mode: 'Disabled',
    });
    expect(mocks.canPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'platform_super' }),
      'settings:write'
    );
  });

  it.each([
    [
      'updateMode',
      (caller: ReturnType<typeof aiSettingsRouter.createCaller>) =>
        caller.updateMode({ mode: 'Disabled' }),
    ],
    [
      'updateMonthlyBudget',
      (caller: ReturnType<typeof aiSettingsRouter.createCaller>) =>
        caller.updateMonthlyBudget({ monthlyAnthropicBudgetUsd: '10' }),
    ],
    [
      'updateTierModel',
      (caller: ReturnType<typeof aiSettingsRouter.createCaller>) =>
        caller.updateTierModel({ provider: 'anthropic', tier: 'cheap', model: 'new-haiku' }),
    ],
    [
      'upsertModelPrice',
      (caller: ReturnType<typeof aiSettingsRouter.createCaller>) =>
        caller.upsertModelPrice({
          provider: 'anthropic',
          model: 'haiku',
          inputUsdPerMTok: '1',
          outputUsdPerMTok: '2',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        }),
    ],
  ] as const)('honours the central capability denial for %s', async (_name, mutate) => {
    mocks.canPlatform.mockReturnValue(false);
    await expect(mutate(aiSettingsRouter.createCaller({} as never))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.settingsUpdate).not.toHaveBeenCalled();
    expect(mocks.priceUpsert).not.toHaveBeenCalled();
  });

  it('returns FORBIDDEN to a tenant administrator without a platform session', async () => {
    const { PlatformSecurityError } = await import('@/lib/platform/security');
    mocks.requirePlatformSession.mockRejectedValue(new PlatformSecurityError('Forbidden', 403));
    await expect(
      aiSettingsRouter.createCaller({ session: { user: { role: 'ADMIN' } } } as never).get()
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('writes the old and new field values with the actor in the update transaction', async () => {
    await aiSettingsRouter
      .createCaller({} as never)
      .updateTierModel({ provider: 'anthropic', tier: 'cheap', model: 'new-haiku' });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorPlatformUserId: 'platform_super',
        targetType: 'AISetting',
        targetId: 'default',
        before: { cheapAnthropicModel: 'haiku' },
        after: { cheapAnthropicModel: 'new-haiku' },
        metadata: { field: 'cheapAnthropicModel' },
      }),
    });
    expect(mocks.withPlatformDb).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.aISetting.findUniqueOrThrow.mock.invocationCallOrder[0]
    );
  });

  it.each(['0', '-1', '1000000.0001', '1.00001', 'NaN'])(
    'rejects an invalid monthly budget (%s)',
    async (value) => {
      await expect(
        aiSettingsRouter
          .createCaller({} as never)
          .updateMonthlyBudget({ monthlyAnthropicBudgetUsd: value })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mocks.settingsUpdate).not.toHaveBeenCalled();
    }
  );

  it('canonicalizes decimal input through integer minor units without a JS number', async () => {
    await aiSettingsRouter
      .createCaller({} as never)
      .updateMonthlyBudget({ monthlyAnthropicBudgetUsd: '0001.2' });
    expect(mocks.settingsUpdate).toHaveBeenCalledWith({
      where: { id: 'default' },
      data: { monthlyAnthropicBudgetUsd: '1.2000', updatedBy: 'platform_super' },
    });
  });

  it('rejects empty models and non-positive model prices', async () => {
    const caller = aiSettingsRouter.createCaller({} as never);
    await expect(
      caller.updateTierModel({ provider: 'anthropic', tier: 'cheap', model: ' ' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.upsertModelPrice({
        provider: 'anthropic',
        model: 'haiku',
        inputUsdPerMTok: '0',
        outputUsdPerMTok: '5',
        effectiveFrom: new Date(),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('locks a model-price key before reading its audit pre-image', async () => {
    mocks.priceUpsert.mockResolvedValue({
      id: 'price_1',
      provider: 'anthropic',
      model: 'haiku',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      inputUsdPerMTok: decimal('0.250000'),
      outputUsdPerMTok: decimal('1.250000'),
    });
    await aiSettingsRouter.createCaller({} as never).upsertModelPrice({
      provider: 'anthropic',
      model: 'haiku',
      inputUsdPerMTok: '0.25',
      outputUsdPerMTok: '1.25',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    expect(mocks.queryRaw.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.aIModelPrice.findUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.priceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          inputUsdPerMTok: '0.250000',
          outputUsdPerMTok: '1.250000',
        }),
      })
    );
  });
});
