import { beforeEach, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { AIModelSelection } from '@/lib/ai/provider';
const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  model: vi.fn(),
  generateText: vi.fn(),
  availability: vi.fn(),
}));
vi.mock('@/lib/ai/provider', () => ({
  readAIConfig: mocks.config,
  createAIModel: mocks.model,
  readAIAvailability: mocks.availability,
}));
vi.mock('ai', async () => ({ ...(await vi.importActual('ai')), generateText: mocks.generateText }));
import { generateRestaurantGrowth, listRestaurantGrowth } from './growth-generation';
import { validateRestaurantGrowthPersisted, restaurantGrowthBinding } from './growth-binding';
import { cateringGrowthInput, growthSourceHash } from './growth-source';
import { restaurantGrowthInputHash } from './growth-snapshot';
import { growthSourceFixture } from '../../../tests/fixtures/restaurant-growth-source';
import type { GrowthActor } from './growth-review';
const output = {
  recommendations: [
    {
      actionRef: 'a1',
      evidenceRefs: ['e1'],
      hypothesis: 'REVIEW_CATERING',
      limitations: ['OBSERVATIONAL'],
    },
  ],
};
const query = vi.fn(),
  write = vi.fn();
let h: GrowthActor,
  provenance = growthSourceFixture();
const request = {
  branchId: 'branch',
  from: '2026-10-01',
  to: '2026-10-01',
  requestId: '11111111-1111-4111-8111-111111111111',
};
const snapshot = () => ({
  ...cateringGrowthInput(provenance),
  _restaurant: {
    version: 'restaurant-growth-v2',
    fingerprint: 'test request',
    provenance,
    sourceHash: growthSourceHash(provenance),
    failureReason: null,
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.availability.mockReturnValue({ available: true, provider: 'groq' });
  provenance = growthSourceFixture();
  mocks.config.mockReturnValue({ provider: 'groq', model: 'DETERMINISTIC_CATERING_TOKENS' });
  mocks.model.mockReturnValue({
    model: new MockLanguageModelV3(),
    provider: 'groq',
    modelId: 'DETERMINISTIC_CATERING_TOKENS',
  } satisfies AIModelSelection);
  mocks.generateText.mockResolvedValue({ output, finishReason: 'stop' });
  query.mockImplementation(async (sql: string) =>
    sql.includes('WITH periods') ? [{ source: structuredClone(provenance.source) }] : []
  );
  write.mockResolvedValue(1);
  const db = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: write,
    organization: { findFirst: vi.fn(async () => ({ vertical: 'RESTAURANT' })) },
    restaurantBranch: { findFirst: vi.fn(async () => ({ id: 'branch' })) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  h = {
    db,
    ctx: {
      organizationId: 'org',
      userId: 'user',
      vertical: 'RESTAURANT',
      enabledModules: ['restaurant-core', 'restaurant-pos'],
    },
    can: vi.fn(async () => true),
  } as unknown as GrowthActor;
});
it('production orchestration uses shared generator and stores envelope/attribution/output', async () => {
  expect((await generateRestaurantGrowth(h, request)).status).toBe('READY');
  const call = write.mock.calls[0],
    saved = JSON.parse(call[10]);
  expect(call.slice(6, 10)).toEqual([
    'READY',
    null,
    'groq',
    'DETERMINISTIC_CATERING_TOKENS',
  ]);
  expect(saved.actions).toEqual([{ ref: 'a1', kind: 'CATERING_REVIEW' }]);
  expect(
    validateRestaurantGrowthPersisted(saved, JSON.parse(call[11])).recommendations[0].evidence[0]
  ).toMatchObject({ value: '10', unit: 'COUNT' });
  const prompt = mocks.generateText.mock.calls[0][0].prompt;
  for (const privateValue of [
    'booking-0',
    'customer-0',
    'quote-0',
    '_restaurant',
    'fingerprint',
    'provenance',
  ])
    expect(prompt).not.toContain(privateValue);
});
it.each([0, 9])('suppresses sparse %s before provider configuration', async (count) => {
  provenance = growthSourceFixture(count);
  expect((await generateRestaurantGrowth(h, request)).status).toBe('INSUFFICIENT_DATA');
  expect(mocks.config).not.toHaveBeenCalled();
  expect(mocks.generateText).not.toHaveBeenCalled();
  expect(JSON.parse(write.mock.calls[0][10]).facts).toEqual([]);
});
it('persists unavailable absent/malformed source without model call', async () => {
  query.mockResolvedValue([]);
  expect((await generateRestaurantGrowth(h, request)).status).toBe('UNAVAILABLE');
  expect(JSON.parse(write.mock.calls[0][10])._restaurant.failureReason).toBe('SOURCE_UNAVAILABLE');
  expect(mocks.config).not.toHaveBeenCalled();
});
it('unconfigured production result remains unavailable', async () => {
  mocks.config.mockImplementation(() => {
    throw new Error('Missing explicit configuration');
  });
  expect((await generateRestaurantGrowth(h, request)).status).toBe('UNAVAILABLE');
  expect(write.mock.calls[0][7]).toBe('CONFIGURATION');
  expect(mocks.generateText).not.toHaveBeenCalled();
});
it.each(['legacy', 'versioned'])(
  'replays %s actor request before source/model work',
  async (version) => {
    const fingerprint = JSON.stringify({ actorId: 'user', input: request });
    query.mockImplementation(async (sql: string) =>
      sql.includes('SELECT snapshot,status')
        ? [
            {
              status: 'UNAVAILABLE',
              snapshot: version === 'legacy' ? { fingerprint } : { _restaurant: { fingerprint } },
            },
          ]
        : []
    );
    expect((await generateRestaurantGrowth(h, request)).status).toBe('UNAVAILABLE');
    expect(write).not.toHaveBeenCalled();
    expect(mocks.config).not.toHaveBeenCalled();
  }
);
it('rejects conflicting request replay', async () => {
  query.mockImplementation(async (sql: string) =>
    sql.includes('SELECT snapshot,status')
      ? [{ snapshot: { fingerprint: 'other' }, status: 'UNAVAILABLE' }]
      : []
  );
  await expect(generateRestaurantGrowth(h, request)).rejects.toMatchObject({ code: 'CONFLICT' });
});
it.each([{ vertical: 'PHARMACY' }, { enabledModules: [] }])(
  'denies invalid context %j',
  async (change) => {
    Object.assign(h.ctx, change);
    await expect(generateRestaurantGrowth(h, request)).rejects.toMatchObject({ code: 'DENIED' });
    expect(write).not.toHaveBeenCalled();
  }
);
it('requires catering permission and reauthorization after generation', async () => {
  vi.mocked(h.can).mockImplementation(async (permission) => permission !== 'catering:read');
  await expect(generateRestaurantGrowth(h, request)).rejects.toMatchObject({ code: 'DENIED' });
  vi.mocked(h.can).mockResolvedValue(true);
  mocks.generateText.mockImplementation(async () => {
    vi.mocked(h.can).mockResolvedValue(false);
    return { output, finishReason: 'stop' };
  });
  await expect(generateRestaurantGrowth(h, request)).rejects.toMatchObject({ code: 'DENIED' });
  expect(write).not.toHaveBeenCalled();
});
it('rejects unbounded/injected client fields', async () => {
  await expect(
    generateRestaurantGrowth(h, { ...request, provider: 'TEST_DOUBLE' })
  ).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});
it('changed equal-valued membership during generation never saves READY', async () => {
  mocks.generateText.mockImplementation(async () => {
    provenance.source.periods[0].bookings[0].id = 'replacement';
    return { output, finishReason: 'stop' };
  });
  expect((await generateRestaurantGrowth(h, request)).status).toBe('UNAVAILABLE');
  expect(JSON.parse(write.mock.calls[0][10])._restaurant.failureReason).toBe(
    'SOURCE_CHANGED_DURING_GENERATION'
  );
  expect(write.mock.calls[0][11]).toBeNull();
});
it.each([
  { ...output, roi: '100%' },
  { recommendations: [{ ...output.recommendations[0], evidenceRefs: ['e999'] }] },
  { recommendations: [{ ...output.recommendations[0], hypothesis: 'REVIEW_RETAIL' }] },
])('shared validator rejects fabricated/malformed output %j', async (invalid) => {
  mocks.generateText.mockResolvedValue({ output: invalid, finishReason: 'stop' });
  expect((await generateRestaurantGrowth(h, request)).status).toBe('INVALID');
  expect(write.mock.calls[0][11]).toBeNull();
});
it('shared deadline stores TIMEOUT without transport retry', async () => {
  vi.useFakeTimers();
  try {
    mocks.generateText.mockImplementation(() => new Promise(() => {}));
    const pending = generateRestaurantGrowth(h, request);
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await pending).status).toBe('UNAVAILABLE');
    expect(write.mock.calls[0][7]).toBe('TIMEOUT');
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it('lists bounded scoped summaries', async () => {
  query.mockImplementation(async (sql: string) =>
    sql.includes('SELECT id,status')
      ? Array.from({ length: 21 }, (_, i) => ({
          id: String(i),
          status: 'UNAVAILABLE',
          createdAt: new Date(),
        }))
      : []
  );
  const list = await listRestaurantGrowth(h, { branchId: 'branch' });
  expect(list.status).toBe('AVAILABLE');
  if (list.status === 'AVAILABLE') {
    expect(list.items).toHaveLength(20);
    expect(list.truncated).toBe(true);
  }
});
it('bare/legacy READY is rejected and output cannot invent supported evidence', () => {
  expect(() =>
    validateRestaurantGrowthPersisted(cateringGrowthInput(provenance), output)
  ).toThrow();
  const saved = snapshot();
  saved.facts[0].metric = 'loyalty_eligible_count';
  expect(() => validateRestaurantGrowthPersisted(saved, output)).toThrow();
});
it('fresh authorized reread must match exact private membership and values', async () => {
  const saved = structuredClone(snapshot()),
    hash = restaurantGrowthInputHash(cateringGrowthInput(provenance)),
    binding = restaurantGrowthBinding(h),
    scope = { organizationId: 'org', branchId: 'branch' };
  expect(await binding.evidenceIsCurrent(h.db, scope, hash, saved)).toBe(true);
  expect(
    validateRestaurantGrowthPersisted(Object.fromEntries(Object.entries(saved).reverse()), output)
      .recommendations
  ).toHaveLength(1);
  expect(
    await binding.evidenceIsCurrent(h.db, { ...scope, branchId: 'foreign' }, hash, saved)
  ).toBe(false);
  expect(await binding.evidenceIsCurrent(h.db, scope, 'f'.repeat(64), saved)).toBe(false);
  provenance.source.periods[0].bookings[0].id = 'same-valued-replacement';
  expect(await binding.evidenceIsCurrent(h.db, scope, hash, saved)).toBe(false);
});

it('refuses reversed and overlong periods before querying a source', async () => {
  await expect(generateRestaurantGrowth(h, { ...request, to: '2026-09-01' })).rejects.toThrow();
  await expect(generateRestaurantGrowth(h, { ...request, to: '2026-12-01' })).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});
