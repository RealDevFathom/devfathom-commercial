import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePlatformSession: vi.fn(),
  withPlatformDb: vi.fn(),
  auditCreate: vi.fn(),
  settingsUpdate: vi.fn(),
  priceUpsert: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/platform/auth', () => ({ requirePlatformSession: mocks.requirePlatformSession }));
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
  mocks.withPlatformDb.mockImplementation(async (run: (database: typeof db) => unknown) => run(db));
  mocks.settingsUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...settings,
    ...data,
    monthlyAnthropicBudgetUsd:
      typeof data.monthlyAnthropicBudgetUsd === 'number'
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
  });

  it.each(['OPERATIONS', 'AUDITOR'])(
    'returns FORBIDDEN to a non-SuperAdmin platform role (%s)',
    async (role) => {
      mocks.requirePlatformSession.mockResolvedValue({ id: 'platform_other', role });
      await expect(aiSettingsRouter.createCaller({} as never).get()).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  );

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
  });

  it.each([0, -1, 1_000_001, Number.NaN])(
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

  it('rejects empty models and non-positive model prices', async () => {
    const caller = aiSettingsRouter.createCaller({} as never);
    await expect(
      caller.updateTierModel({ provider: 'anthropic', tier: 'cheap', model: ' ' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.upsertModelPrice({
        provider: 'anthropic',
        model: 'haiku',
        inputUsdPerMTok: 0,
        outputUsdPerMTok: 5,
        effectiveFrom: new Date(),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
