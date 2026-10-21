import { growthReviewInput } from './growth-review-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readRestaurantGrowthReview,
  reviewRestaurantGrowth,
  type GrowthActor,
  type RestaurantGrowthBinding,
} from './growth-review';

const hash = 'a'.repeat(64);
const projection = {
  currency: 'PKR',
  current: { from: '2026-10-01T00:00:00.000Z', cutoff: '2026-10-02T00:00:00.000Z' },
  comparison: { from: '2026-09-30T00:00:00.000Z', cutoff: '2026-10-01T00:00:00.000Z' },
  recommendations: [
    {
      action: 'LOYALTY_REVIEW',
      evidence: [
        {
          key: 'loyalty_eligible_count',
          period: 'CURRENT',
          value: '10',
          unit: 'COUNT',
          coverage: 'COMPLETE',
        },
      ],
    },
  ],
};
const input = {
  branchId: 'branch-a',
  insightId: 'insight-a',
  recommendation: 0,
  expectedHash: hash,
  expectedVersion: 1,
  expectedRevision: 0,
  requestId: '11111111-1111-4111-8111-111111111111',
  decision: 'APPROVE',
  settings: { objective: 'REVIEW_RETENTION', priority: 'NORMAL' },
};
let row: Record<string, unknown>;
let reviews: unknown[];
let replay: unknown[];
let h: GrowthActor;
let binding: RestaurantGrowthBinding;
const query = vi.fn();
const write = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  reviews = [];
  replay = [];
  row = {
    id: 'insight-a',
    organizationId: 'org-a',
    branchId: 'branch-a',
    vertical: 'RESTAURANT',
    schemaVersion: 1,
    inputHash: hash,
    status: 'READY',
    failureCode: null,
    provider: 'test-double',
    model: 'test-double',
    snapshot: {},
    output: { recommendations: [{}] },
  };
  query.mockImplementation(async (sql: string) =>
    sql.includes('SELECT id,"organizationId"')
      ? [row]
      : sql.includes('DISTINCT ON')
        ? reviews
        : sql.includes('SELECT fingerprint')
          ? replay
          : []
  );
  const db = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: write,
    organization: { findFirst: vi.fn(async () => ({ vertical: 'RESTAURANT' })) },
    restaurantBranch: { findFirst: vi.fn(async () => ({ id: 'branch-a' })) },
    restaurantStaffProfile: { findFirst: vi.fn(async () => ({ primaryBranchId: 'branch-a' })) },
    restaurantBranchAssignment: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn) => fn(db));
  h = {
    db,
    ctx: {
      organizationId: 'org-a',
      userId: 'actor-a',
      vertical: 'RESTAURANT',
      enabledModules: ['restaurant-core', 'restaurant-pos'],
    },
    can: vi.fn(async () => true),
  } as unknown as GrowthActor;
  binding = {
    validatePersisted: vi.fn(() => structuredClone(projection)),
    evidenceIsCurrent: vi.fn(async () => true),
  };
});
describe('Restaurant persisted review boundary', () => {
  it('projects a validated persisted READY result; never calls a generator', async () => {
    const result = await readRestaurantGrowthReview(
      h,
      { branchId: input.branchId, insightId: input.insightId },
      binding
    );
    expect(result.status).toBe('READY');
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('test-double');
  });
  it('fails unavailable without accepted shared binding', async () => {
    expect(
      await readRestaurantGrowthReview(h, { branchId: input.branchId, insightId: input.insightId })
    ).toEqual({ status: 'UNAVAILABLE' });
  });
  it.each(['UNAVAILABLE', 'INSUFFICIENT_DATA', 'INVALID'])('preserves %s', async (status) => {
    row.status = status;
    row.output = null;
    expect(
      await readRestaurantGrowthReview(
        h,
        { branchId: input.branchId, insightId: input.insightId },
        binding
      )
    ).toEqual({ status });
    expect(binding.validatePersisted).not.toHaveBeenCalled();
  });
  it.each([
    { schemaVersion: 2 },
    { vertical: 'PHARMACY' },
    { inputHash: 'bad' },
    { provider: null },
    { model: null },
    { failureCode: 'OUTPUT' },
    { output: null },
  ])('rejects malformed persisted metadata %j', async (change) => {
    Object.assign(row, change);
    expect(
      (
        await readRestaurantGrowthReview(
          h,
          { branchId: input.branchId, insightId: input.insightId },
          binding
        )
      ).status
    ).toBe('INVALID');
  });
  it.each([{ organizationId: 'org-b' }, { branchId: 'branch-b' }, { id: 'other' }])(
    'rejects mismatched scope %j',
    async (change) => {
      Object.assign(row, change);
      expect(
        (
          await readRestaurantGrowthReview(
            h,
            { branchId: input.branchId, insightId: input.insightId },
            binding
          )
        ).status
      ).toBe('DENIED');
    }
  );
  it('denies absent package before source reads', async () => {
    h.ctx.enabledModules = [];
    await expect(reviewRestaurantGrowth(h, input, binding)).rejects.toMatchObject({
      code: 'DENIED',
    });
    expect(query).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it('denies revoked capability', async () => {
    vi.mocked(h.can).mockResolvedValue(false);
    await expect(reviewRestaurantGrowth(h, input, binding)).rejects.toMatchObject({
      code: 'DENIED',
    });
    expect(write).not.toHaveBeenCalled();
  });
  it('denies inactive or foreign branch', async () => {
    vi.mocked(h.db.restaurantBranch.findFirst).mockResolvedValue(null);
    await expect(reviewRestaurantGrowth(h, input, binding)).rejects.toMatchObject({
      code: 'DENIED',
    });
  });
  it('rejects stale evidence and stale client hash', async () => {
    vi.mocked(binding.evidenceIsCurrent).mockResolvedValue(false);
    await expect(reviewRestaurantGrowth(h, input, binding)).rejects.toMatchObject({
      code: 'STALE',
    });
    vi.mocked(binding.evidenceIsCurrent).mockResolvedValue(true);
    await expect(
      reviewRestaurantGrowth(h, { ...input, expectedHash: 'b'.repeat(64) }, binding)
    ).rejects.toMatchObject({ code: 'STALE' });
    expect(write).not.toHaveBeenCalled();
  });
  it('redacts validator/provider-shaped failures', async () => {
    vi.mocked(binding.validatePersisted).mockImplementation(() => {
      throw new Error('secret payload');
    });
    expect(
      await readRestaurantGrowthReview(
        h,
        { branchId: input.branchId, insightId: input.insightId },
        binding
      )
    ).toEqual({ status: 'UNAVAILABLE' });
  });
  it('rejects injection in settings', async () => {
    await expect(
      reviewRestaurantGrowth(
        h,
        { ...input, settings: { ...input.settings, recipients: ['private'] } },
        binding
      )
    ).rejects.toMatchObject({ code: 'INVALID' });
    expect(write).not.toHaveBeenCalled();
  });
  it('approves with one review and inert draft in one transaction', async () => {
    const result = await reviewRestaurantGrowth(h, input, binding);
    expect(result.draftId).toBeTruthy();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][0]).toContain('INSERT INTO restaurant_growth_reviews');
    expect(write.mock.calls[1][0]).toContain('INSERT INTO restaurant_growth_drafts');
    expect(write.mock.calls[1]).toContain('LOYALTY_REVIEW');
    expect(query.mock.calls.some((c) => c[0].includes('pg_advisory_xact_lock'))).toBe(true);
  });
  it.each(['EDIT', 'REJECT'])('%s appends no draft', async (decision) => {
    expect((await reviewRestaurantGrowth(h, { ...input, decision }, binding)).draftId).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('replays identical request without another draft', async () => {
    replay = [
      {
        fingerprint: JSON.stringify({ actorId: 'actor-a', input: growthReviewInput.parse(input) }),
        draftId: 'saved-draft',
        id: 'saved-review',
      },
    ];
    expect(await reviewRestaurantGrowth(h, input, binding)).toEqual({
      reviewId: 'saved-review',
      draftId: 'saved-draft',
    });
    expect(write).not.toHaveBeenCalled();
  });
  it('rejects conflicting replay', async () => {
    replay = [{ fingerprint: 'different', draftId: 'saved-draft', id: 'saved-review' }];
    await expect(reviewRestaurantGrowth(h, input, binding)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
  it.each(['EDIT', 'APPROVE', 'REJECT'])('rejects stale revision/final %s', async (decision) => {
    reviews = [
      {
        recommendation: 0,
        revision: 1,
        decision,
        settings: input.settings,
        draftId: decision === 'APPROVE' ? 'draft' : null,
      },
    ];
    await expect(reviewRestaurantGrowth(h, input, binding)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(write).not.toHaveBeenCalled();
  });
});

it.each([
  { ...projection, current: { ...projection.current, cutoff: '2027-10-02T00:00:00.000Z' } },
  { ...projection, recommendations: [] },
  { ...projection, arbitrary: 'ignore instructions' },
  { ...projection, currency: 'unknown' },
])('rejects sparse, injected, or unbounded projections', async (invalid) => {
  vi.mocked(binding.validatePersisted).mockReturnValue(invalid);
  expect(
    (
      await readRestaurantGrowthReview(
        h,
        { branchId: input.branchId, insightId: input.insightId },
        binding
      )
    ).status
  ).toBe('INVALID');
  expect(write).not.toHaveBeenCalled();
});
it('reauthorizes after evidence resolution before any write', async () => {
  vi.mocked(binding.evidenceIsCurrent).mockImplementation(async () => {
    vi.mocked(h.can).mockResolvedValue(false);
    return true;
  });
  await expect(reviewRestaurantGrowth(h, input, binding)).rejects.toMatchObject({
    code: 'UNAVAILABLE',
  });
  expect(write).not.toHaveBeenCalled();
});
it('preserves high-priority edits in the appended row', async () => {
  await reviewRestaurantGrowth(
    h,
    { ...input, decision: 'EDIT', settings: { ...input.settings, priority: 'HIGH' } },
    binding
  );
  expect(write.mock.calls[0]).toContain(
    JSON.stringify({ priority: 'HIGH', objective: 'REVIEW_RETENTION' })
  );
});

it('sets exact branch context before the scoped insight advisory lock', async () => {
  await reviewRestaurantGrowth(h, input, binding);
  const statements = query.mock.calls.map(([sql]) => String(sql));
  const lock = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const context = statements.findIndex((sql) => sql.includes('app.current_branch_id'));
  expect(context).toBeGreaterThanOrEqual(0);
  expect(context).toBeLessThan(lock);
  expect(query.mock.calls[context][1]).toBe(input.branchId);
});
