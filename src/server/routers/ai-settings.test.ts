import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePlatformSession: vi.fn(),
  withPlatformDb: vi.fn(),
  readProviderSpend: vi.fn(),
  queryRaw: vi.fn(),
  auditCreate: vi.fn(),
  settingsFindUnique: vi.fn(),
  settingsUpsert: vi.fn(),
  priceFindMany: vi.fn(),
  priceFindUnique: vi.fn(),
  priceUpsert: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/platform/auth', async () => {
  const { canPlatformRole } = await import('@/lib/platform/capabilities');
  return {
    requirePlatformSession: mocks.requirePlatformSession,
    // The real capability table, so each platform role is judged as in production.
    canPlatform: (identity: { role: never; enrollmentOnly?: boolean }, capability: string) =>
      !identity.enrollmentOnly && canPlatformRole(identity.role, capability),
  };
});
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb,
  withTenantDb: vi.fn(),
}));
vi.mock('@/lib/ai/spend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/spend')>()),
  readProviderSpend: mocks.readProviderSpend,
}));

import { PlatformSecurityError } from '@/lib/platform/security';

import { aiSettingsRouter, capStatus } from './ai-settings';

type Row = Record<string, unknown> & { id: string };
type Caller = ReturnType<typeof aiSettingsRouter.createCaller>;

const decimal = (value: string) => ({ toString: () => value, valueOf: () => Number(value) });

/** Column defaults exactly as the migration creates the singleton. */
function blankRow(): Row {
  return {
    id: 'default',
    mode: 'Auto',
    providerOrder: [],
    fallbackEnabled: true,
    anthropicMonthlyCapUsd: null,
    openaiMonthlyCapUsd: null,
    bedrockMonthlyCapUsd: null,
    cheapAnthropicModel: null,
    standardAnthropicModel: null,
    deepAnthropicModel: null,
    cheapOpenaiModel: null,
    standardOpenaiModel: null,
    deepOpenaiModel: null,
    cheapBedrockModel: null,
    standardBedrockModel: null,
    deepBedrockModel: null,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    updatedBy: null,
  };
}

const CAP_COLUMNS = ['anthropicMonthlyCapUsd', 'openaiMonthlyCapUsd', 'bedrockMonthlyCapUsd'];

let stored: Row | null;
const transactionLog: string[] = [];

const db = {
  $queryRawUnsafe: mocks.queryRaw,
  aISetting: { findUnique: mocks.settingsFindUnique, upsert: mocks.settingsUpsert },
  aIModelPrice: {
    findMany: mocks.priceFindMany,
    findUnique: mocks.priceFindUnique,
    upsert: mocks.priceUpsert,
  },
  platformAuditLog: { create: mocks.auditCreate },
};

function applyWrite(data: Record<string, unknown>): Row {
  const next = { ...(stored ?? blankRow()), ...data, updatedAt: new Date() } as Row;
  for (const column of CAP_COLUMNS) {
    const value = next[column];
    if (typeof value === 'string') next[column] = decimal(value);
  }
  return next;
}

const superAdmin = { id: 'platform_super', role: 'SUPER_ADMIN' };
const caller = (ctx: Record<string, unknown> = {}): Caller =>
  aiSettingsRouter.createCaller(ctx as never);

beforeEach(() => {
  vi.clearAllMocks();
  stored = null;
  transactionLog.length = 0;
  for (const name of [
    'AI_PROVIDER',
    'AI_PROVIDER_ORDER',
    'ANTHROPIC_API_KEY_SECRET_ID',
    'OPENAI_API_KEY_SECRET_ID',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'BEDROCK_REGION',
    'AI_BEDROCK_REGION',
    'AI_ANTHROPIC_MONTHLY_CAP_USD',
    'AI_OPENAI_MONTHLY_CAP_USD',
    'AI_BEDROCK_MONTHLY_CAP_USD',
    'AI_OPENAI_MODEL_STANDARD',
  ]) {
    vi.stubEnv(name, '');
  }
  mocks.requirePlatformSession.mockResolvedValue(superAdmin);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.readProviderSpend.mockResolvedValue(0);
  mocks.withPlatformDb.mockImplementation(async (run: (database: typeof db) => unknown) => {
    transactionLog.push('begin');
    try {
      return await run(db);
    } finally {
      transactionLog.push('end');
    }
  });
  mocks.settingsFindUnique.mockImplementation(async () => (stored ? { ...stored } : null));
  mocks.settingsUpsert.mockImplementation(
    async ({
      create,
      update,
    }: {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      stored = applyWrite(stored ? update : create);
      return { ...stored };
    }
  );
  mocks.auditCreate.mockImplementation(async () => {
    transactionLog.push('audit');
    return { id: 'audit_1' };
  });
  mocks.priceFindMany.mockResolvedValue([]);
  mocks.priceFindUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const mutations: Array<[string, (c: Caller) => Promise<unknown>]> = [
  ['setMode', (c) => c.setMode({ mode: 'Disabled' })],
  ['setProviderOrder', (c) => c.setProviderOrder({ providerOrder: ['openai'] })],
  ['setFallbackEnabled', (c) => c.setFallbackEnabled({ fallbackEnabled: false })],
  ['setMonthlyCap', (c) => c.setMonthlyCap({ provider: 'openai', capUsd: '10' })],
  [
    'setTierModel',
    (c) => c.setTierModel({ provider: 'anthropic', tier: 'cheap', model: 'claude-x' }),
  ],
  ['reset', (c) => c.reset({ scope: 'all' })],
  [
    'upsertModelPrice',
    (c) =>
      c.upsertModelPrice({
        provider: 'anthropic',
        model: 'claude-x',
        inputUsdPerMTok: '1',
        outputUsdPerMTok: '2',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      }),
  ],
];
const queries: Array<[string, (c: Caller) => Promise<unknown>]> = [
  ['get', (c) => c.get()],
  ['listModelPrices', (c) => c.listModelPrices()],
];

describe('AI settings authorization', () => {
  it.each([...queries, ...mutations])('allows a SUPER_ADMIN to call %s', async (_name, call) => {
    mocks.priceUpsert.mockResolvedValue({
      id: 'price_1',
      inputUsdPerMTok: decimal('1.000000'),
      outputUsdPerMTok: decimal('2.000000'),
    });
    await expect(call(caller())).resolves.toBeDefined();
  });

  const otherRoles = ['OPERATIONS', 'SALES', 'FINANCE', 'SUPPORT', 'AUDITOR'];
  it.each(
    otherRoles.flatMap((role) =>
      [...queries, ...mutations].map(([name, call]) => [role, name, call] as const)
    )
  )('refuses platform role %s on %s', async (role, _name, call) => {
    mocks.requirePlatformSession.mockResolvedValue({ id: `platform_${role}`, role });
    await expect(call(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a SUPER_ADMIN enrollment-only session', async () => {
    mocks.requirePlatformSession.mockResolvedValue({ ...superAdmin, enrollmentOnly: true });
    await expect(caller().setMode({ mode: 'Auto' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([...queries, ...mutations])(
    'refuses a tenant session without a platform session on %s',
    async (_name, call) => {
      mocks.requirePlatformSession.mockRejectedValue(
        new PlatformSecurityError('Platform authentication is required.', 401)
      );
      const tenant = caller({ session: { user: { id: 'tenant_admin', role: 'ADMIN' } } });
      await expect(call(tenant)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.withPlatformDb).not.toHaveBeenCalled();
    }
  );

  it('asks an anonymous caller to sign in', async () => {
    mocks.requirePlatformSession.mockRejectedValue(
      new PlatformSecurityError('Platform authentication is required.', 401)
    );
    await expect(caller().get()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('AI settings read', () => {
  it('returns environment defaults, configured providers and spend before any save', async () => {
    vi.stubEnv('AI_PROVIDER', 'auto');
    vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ID', 'devfathom/staging/anthropic-api-key');
    vi.stubEnv('BEDROCK_REGION', 'us-east-1');
    vi.stubEnv('AI_OPENAI_MODEL_STANDARD', 'gpt-env-standard');
    mocks.readProviderSpend.mockImplementation(async (provider: string) =>
      provider === 'anthropic' ? 190 : provider === 'openai' ? 12.5 : 250
    );

    const view = await caller().get();

    expect(view.mode).toEqual({ value: 'Auto', isOverride: false });
    expect(view.providerOrder).toMatchObject({
      value: ['anthropic', 'openai', 'bedrock'],
      isOverride: false,
      defaultSource: 'built-in',
    });
    expect(view.fallbackEnabled).toEqual({ value: true, isOverride: false });
    expect(view.chain).toEqual(['anthropic', 'openai', 'bedrock']);
    expect(view.routing).toBe('active');
    expect(view.appliesWithinSeconds).toBe(30);
    expect(view.updatedAt).toBeNull();

    const byName = Object.fromEntries(view.providers.map((entry) => [entry.provider, entry]));
    expect(Object.keys(byName)).toEqual(['anthropic', 'openai', 'bedrock']);
    expect(byName.anthropic).toMatchObject({
      configured: true,
      spentUsd: 190,
      capUsd: 190,
      capIsOverride: false,
      capStatus: 'at',
    });
    expect(byName.openai).toMatchObject({ configured: false, capUsd: 190, capStatus: 'under' });
    expect(byName.bedrock).toMatchObject({ configured: true, capUsd: 300, capStatus: 'near' });
    expect(byName.openai.models).toContainEqual({
      tier: 'standard',
      value: 'gpt-env-standard',
      isOverride: false,
      defaultValue: 'gpt-env-standard',
      defaultSource: 'environment',
    });

    // The month is the Asia/Karachi month, and only routed providers are read.
    const [, from, to] = mocks.readProviderSpend.mock.calls[0]!;
    expect((to as Date).getTime() - (from as Date).getTime()).toBeGreaterThan(27 * 86_400_000);
    expect(mocks.readProviderSpend.mock.calls.map(([name]) => name)).toEqual([
      'anthropic',
      'openai',
      'bedrock',
    ]);
  });

  it('marks SuperAdmin overrides and resolves them over the environment', async () => {
    vi.stubEnv('AI_OPENAI_MONTHLY_CAP_USD', '50');
    stored = {
      ...blankRow(),
      mode: 'ForceOpenAI',
      providerOrder: ['bedrock', 'anthropic'],
      fallbackEnabled: false,
      openaiMonthlyCapUsd: decimal('25.5000'),
      deepBedrockModel: 'global.anthropic.custom-deep',
      updatedBy: 'platform_super',
    };

    const view = await caller().get();

    expect(view.mode).toEqual({ value: 'ForceOpenAI', isOverride: true });
    expect(view.providerOrder).toMatchObject({
      value: ['bedrock', 'anthropic'],
      isOverride: true,
      defaultValue: ['anthropic', 'openai', 'bedrock'],
    });
    expect(view.fallbackEnabled).toEqual({ value: false, isOverride: true });
    // Forced first, and fallback off keeps only that one.
    expect(view.chain).toEqual(['openai']);
    const openai = view.providers.find((entry) => entry.provider === 'openai')!;
    expect(openai).toMatchObject({
      capUsd: 25.5,
      capIsOverride: true,
      defaultCapUsd: 50,
      defaultCapSource: 'environment',
    });
    const bedrock = view.providers.find((entry) => entry.provider === 'bedrock')!;
    expect(bedrock.models.find((entry) => entry.tier === 'deep')).toMatchObject({
      value: 'global.anthropic.custom-deep',
      isOverride: true,
      defaultValue: 'global.anthropic.claude-sonnet-5-5',
    });
    expect(view.updatedBy).toBe('platform_super');
  });

  it('reports unknown spend instead of failing the console', async () => {
    mocks.readProviderSpend.mockRejectedValueOnce(new Error('ledger down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = await caller().get();
    expect(view.providers[0]).toMatchObject({ spentUsd: null, capStatus: 'unknown' });
  });

  it('never lists Azure and reports a legacy AI_PROVIDER as bypassing routing', async () => {
    vi.stubEnv('AI_PROVIDER', 'azure');
    const view = await caller().get();
    expect(view.routing).toBe('bypassed');
    expect(view.providers.map((entry) => entry.provider)).not.toContain('azure');
    expect(JSON.stringify(view)).not.toMatch(/azure/i);
  });

  it('never returns a secret value', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-local-secret-value');
    vi.stubEnv('OPENAI_API_KEY_SECRET_ID', 'devfathom/staging/openai-api-key');
    const view = await caller().get();
    const text = JSON.stringify(view);
    expect(text).not.toContain('sk-ant-local-secret-value');
    expect(text).not.toContain('devfathom/staging/openai-api-key');
    expect(view.providers.find((entry) => entry.provider === 'openai')?.configured).toBe(true);
  });

  it.each([
    [null, 10, 'unknown'],
    [0, 10, 'under'],
    [8, 10, 'near'],
    [10, 10, 'at'],
    [0, 0, 'at'],
    [10.01, 10, 'over'],
  ] as const)('cap status for spend %s of cap %s is %s', (spent, cap, status) => {
    expect(capStatus(spent, cap)).toBe(status);
  });
});

describe('AI settings mutations', () => {
  it('creates the singleton on first save and audits it in the same transaction', async () => {
    await caller({ requestMeta: { ip: '10.0.0.1', userAgent: 'vitest' } }).setMode({
      mode: 'ForceBedrock',
    });

    expect(mocks.withPlatformDb).toHaveBeenCalledTimes(1);
    expect(transactionLog).toEqual(['begin', 'audit', 'end']);
    expect(mocks.queryRaw.mock.calls[0]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'ai_settings:default',
    ]);
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.settingsFindUnique.mock.invocationCallOrder[0]!
    );
    expect(mocks.settingsUpsert).toHaveBeenCalledWith({
      where: { id: 'default' },
      create: { id: 'default', mode: 'ForceBedrock', updatedBy: 'platform_super' },
      update: { mode: 'ForceBedrock', updatedBy: 'platform_super' },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        actorPlatformUserId: 'platform_super',
        action: 'ai.settings.updated',
        targetType: 'AISetting',
        targetId: 'default',
        before: { mode: null },
        after: { mode: 'ForceBedrock' },
        metadata: { fields: ['mode'], created: true },
        ip: '10.0.0.1',
        userAgent: 'vitest',
      },
    });
  });

  it('records the previous stored value as the audit pre-image', async () => {
    stored = { ...blankRow(), openaiMonthlyCapUsd: decimal('190.0000') };
    const result = await caller().setMonthlyCap({ provider: 'openai', capUsd: '0001.2' });
    expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { openaiMonthlyCapUsd: '1.2000', updatedBy: 'platform_super' },
      })
    );
    expect(mocks.auditCreate.mock.calls[0]![0].data).toMatchObject({
      before: { openaiMonthlyCapUsd: '190.0000' },
      after: { openaiMonthlyCapUsd: '1.2000' },
      metadata: { fields: ['openaiMonthlyCapUsd'], provider: 'openai', created: false },
    });
    expect(result.capsUsd.openai).toBe('1.2000');
  });

  it('allows a zero cap, which blocks the provider', async () => {
    await caller().setMonthlyCap({ provider: 'bedrock', capUsd: '0' });
    expect(stored?.bedrockMonthlyCapUsd?.toString()).toBe('0.0000');
  });

  it.each(['-1', '1000000.0001', '1.00001', 'NaN', 'Infinity', '1e3', '', ' ', '12,5'])(
    'rejects the monthly cap %j',
    async (capUsd) => {
      await expect(caller().setMonthlyCap({ provider: 'anthropic', capUsd })).rejects.toMatchObject(
        { code: 'BAD_REQUEST' }
      );
      expect(mocks.settingsUpsert).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it('accepts the largest allowed cap', async () => {
    await caller().setMonthlyCap({ provider: 'anthropic', capUsd: '1000000' });
    expect(stored?.anthropicMonthlyCapUsd?.toString()).toBe('1000000.0000');
  });

  it('saves a subset order in the given sequence', async () => {
    await caller().setProviderOrder({ providerOrder: ['bedrock', 'openai'] });
    expect(stored?.providerOrder).toEqual(['bedrock', 'openai']);
    expect(mocks.auditCreate.mock.calls[0]![0].data).toMatchObject({
      before: { providerOrder: null },
      after: { providerOrder: ['bedrock', 'openai'] },
    });
  });

  it.each([
    ['empty', []],
    ['duplicate', ['anthropic', 'anthropic']],
    ['unknown provider', ['anthropic', 'mistral']],
    ['Azure', ['azure']],
    ['too long', ['anthropic', 'openai', 'bedrock', 'anthropic']],
  ])('rejects a %s provider order', async (_label, providerOrder) => {
    await expect(
      caller().setProviderOrder({ providerOrder: providerOrder as never })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
  });

  it('rejects an unknown mode', async () => {
    await expect(caller().setMode({ mode: 'ForceAzure' as never })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('saves the fallback switch', async () => {
    await caller().setFallbackEnabled({ fallbackEnabled: false });
    expect(stored?.fallbackEnabled).toBe(false);
    await expect(
      caller().setFallbackEnabled({ fallbackEnabled: 'no' as never })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('trims and saves a tier model for each routed provider', async () => {
    await caller().setTierModel({ provider: 'openai', tier: 'deep', model: '  gpt-custom  ' });
    expect(stored?.deepOpenaiModel).toBe('gpt-custom');
    expect(mocks.auditCreate.mock.calls[0]![0].data).toMatchObject({
      before: { deepOpenaiModel: null },
      after: { deepOpenaiModel: 'gpt-custom' },
      metadata: { fields: ['deepOpenaiModel'], provider: 'openai', tier: 'deep' },
    });
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['inner space', 'gpt 5'],
    ['tab', 'gpt\t5'],
    ['newline', 'gpt\n5'],
    ['too long', 'x'.repeat(201)],
  ])('rejects a %s model id', async (_label, model) => {
    await expect(
      caller().setTierModel({ provider: 'anthropic', tier: 'standard', model })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
  });

  it('rejects Azure and unknown tiers for a tier model', async () => {
    await expect(
      caller().setTierModel({ provider: 'azure' as never, tier: 'cheap', model: 'gpt-4o' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().setTierModel({ provider: 'openai', tier: 'premium' as never, model: 'gpt-4o' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().setMonthlyCap({ provider: 'azure' as never, capUsd: '1' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses extra fields', async () => {
    await expect(
      caller().setMode({ mode: 'Auto', updatedBy: 'someone' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('AI settings reset', () => {
  const overridden = (): Row => ({
    ...blankRow(),
    mode: 'Disabled',
    providerOrder: ['openai'],
    fallbackEnabled: false,
    anthropicMonthlyCapUsd: decimal('5.0000'),
    openaiMonthlyCapUsd: decimal('6.0000'),
    bedrockMonthlyCapUsd: decimal('7.0000'),
    cheapAnthropicModel: 'a',
    standardOpenaiModel: 'b',
    deepBedrockModel: 'c',
  });

  it('returns every value to the environment default and audits the pre-image', async () => {
    stored = overridden();
    await caller().reset({ scope: 'all' });

    expect(stored).toMatchObject({
      ...blankRow(),
      updatedAt: expect.any(Date),
      updatedBy: 'platform_super',
    });
    const audit = mocks.auditCreate.mock.calls[0]![0].data;
    expect(audit).toMatchObject({
      action: 'ai.settings.reset',
      before: {
        mode: 'Disabled',
        providerOrder: ['openai'],
        fallbackEnabled: false,
        anthropicMonthlyCapUsd: '5.0000',
        cheapAnthropicModel: 'a',
        deepBedrockModel: 'c',
      },
      after: {
        mode: 'Auto',
        providerOrder: [],
        fallbackEnabled: true,
        anthropicMonthlyCapUsd: null,
        cheapAnthropicModel: null,
        deepBedrockModel: null,
      },
      metadata: { scope: 'all' },
    });
    expect(audit.metadata.fields).toHaveLength(15);

    const view = await caller().get();
    expect(view.mode.isOverride).toBe(false);
    expect(view.providerOrder.isOverride).toBe(false);
    expect(view.providers.every((entry) => !entry.capIsOverride)).toBe(true);
    expect(view.providers.flatMap((entry) => entry.models).every((m) => !m.isOverride)).toBe(true);
  });

  it.each([
    [{ scope: 'mode' }, { mode: 'Auto' }],
    [{ scope: 'providerOrder' }, { providerOrder: [] }],
    [{ scope: 'fallbackEnabled' }, { fallbackEnabled: true }],
    [{ scope: 'cap', provider: 'openai' }, { openaiMonthlyCapUsd: null }],
    [{ scope: 'model', provider: 'bedrock', tier: 'deep' }, { deepBedrockModel: null }],
  ] as const)('resets only %j', async (input, expected) => {
    stored = overridden();
    await caller().reset(input as never);
    expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { ...expected, updatedBy: 'platform_super' } })
    );
    expect(stored).toMatchObject(expected);
    // Everything else stays overridden.
    expect(stored?.cheapAnthropicModel).toBe('a');
  });

  it.each([
    { scope: 'cap', provider: 'azure' },
    { scope: 'model', provider: 'openai' },
    { scope: 'everything' },
  ])('rejects the reset %j', async (input) => {
    await expect(caller().reset(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
  });
});

describe('AI model prices', () => {
  it('versions an OpenAI price under an advisory lock and audits it', async () => {
    mocks.priceUpsert.mockResolvedValue({
      id: 'price_1',
      provider: 'openai',
      model: 'gpt-5.4',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      inputUsdPerMTok: decimal('2.500000'),
      outputUsdPerMTok: decimal('15.000000'),
    });
    await caller().upsertModelPrice({
      provider: 'openai',
      model: 'gpt-5.4',
      inputUsdPerMTok: '2.5',
      outputUsdPerMTok: '15',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    expect(mocks.queryRaw.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    // PostgreSQL text cannot hold a NUL byte, so the lock key is a JSON tuple.
    const lockKey = mocks.queryRaw.mock.calls[0]?.[1] as string;
    expect(lockKey).not.toContain('\u0000');
    expect(JSON.parse(lockKey)).toEqual(['openai', 'gpt-5.4', '2026-01-01T00:00:00.000Z']);
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.priceFindUnique.mock.invocationCallOrder[0]!
    );
    expect(mocks.priceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          provider: 'openai',
          inputUsdPerMTok: '2.500000',
          outputUsdPerMTok: '15.000000',
        }),
      })
    );
    expect(mocks.auditCreate.mock.calls[0]![0].data).toMatchObject({
      action: 'ai.model-price.upserted',
      before: { inputUsdPerMTok: null, outputUsdPerMTok: null },
      after: { inputUsdPerMTok: '2.500000', outputUsdPerMTok: '15.000000' },
      metadata: { provider: 'openai', created: true },
    });
  });

  it('rejects non-positive prices, empty models and Azure', async () => {
    const base = {
      provider: 'anthropic' as const,
      model: 'claude-x',
      inputUsdPerMTok: '1',
      outputUsdPerMTok: '1',
      effectiveFrom: new Date(),
    };
    await expect(
      caller().upsertModelPrice({ ...base, inputUsdPerMTok: '0' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().upsertModelPrice({ ...base, model: ' ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().upsertModelPrice({ ...base, provider: 'azure' as never })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.priceUpsert).not.toHaveBeenCalled();
  });
});
