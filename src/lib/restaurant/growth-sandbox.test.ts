import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), consent: vi.fn() }));
vi.mock('./growth-review', async () => ({
  ...(await vi.importActual<typeof import('./growth-review')>('./growth-review')),
  readRestaurantGrowthReview: mocks.read,
}));
vi.mock('./customers', () => ({ appendCustomerConsent: mocks.consent }));
import {
  captureRestaurantGrowthDraft,
  stopRestaurantGrowthSandbox,
  diagnoseRestaurantGrowthSandbox,
  growthSandboxQuiet,
  type GrowthSandboxAdmission,
} from './growth-sandbox';
import type { GrowthActor, RestaurantGrowthBinding } from './growth-review';
const policy: GrowthSandboxAdmission = {
  environment: 'TEST_SANDBOX',
  database: 'restaurant_growth_test_local',
  port: 55499,
  policyVersion: 'TEST_V1',
  timeZone: 'UTC',
  quietStart: 22,
  quietEnd: 8,
  campaignCap: 2,
  recipientBranchDailyCap: 1,
};
const input = {
  branchId: 'b',
  draftId: 'd',
  requestId: '11111111-1111-4111-8111-111111111111',
  cutoff: '2026-10-07T11:00:00.000Z',
};
const query = vi.fn();
const write = vi.fn();
const consent = vi.fn();
let h: GrowthActor;
let server: Record<string, unknown>;
let action: string;
let previous: unknown[];
let count: number;
const binding = {} as RestaurantGrowthBinding;
beforeEach(() => {
  vi.clearAllMocks();
  action = 'LOYALTY_REVIEW';
  previous = [];
  count = 0;
  server = {
    database: policy.database,
    address: '127.0.0.1',
    port: policy.port,
    rolsuper: false,
    rolbypassrls: false,
  };
  query.mockImplementation(async (sql: string) =>
    sql.includes('pg_roles')
      ? [server]
      : sql.includes('clock_timestamp() AS now')
        ? [{ now: new Date('2026-10-07T12:00:00Z') }]
        : sql.includes('SELECT "insightId"')
          ? [{ insightId: 'i', recommendation: 0, reviewId: 'r', action }]
          : sql.includes('SELECT id,"customerId",fingerprint,state')
            ? previous
            : sql.includes('SELECT f."customerId"')
              ? [{ customerId: 'c1' }, { customerId: 'c2' }, { customerId: 'c3' }]
              : sql.includes('SELECT c.id')
                ? [{ id: 'c1' }]
                : sql.includes('count(*)')
                  ? [{ count }]
                  : sql.includes('SELECT "customerId"')
                    ? [{ customerId: 'c1' }]
                    : []
  );
  consent.mockResolvedValue({ granted: true });
  mocks.read.mockResolvedValue({
    status: 'READY',
    reviews: [{ recommendation: 0, decision: 'APPROVE', draftId: 'd' }],
  });
  const db = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: write,
    customerConsent: { findFirst: consent },
    organization: { findFirst: vi.fn(async () => ({ vertical: 'RESTAURANT' })) },
    restaurantBranch: { findFirst: vi.fn(async () => ({ id: 'b' })) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  h = {
    db,
    ctx: {
      organizationId: 'o',
      userId: 'u',
      vertical: 'RESTAURANT',
      enabledModules: ['restaurant-core', 'restaurant-pos'],
    },
    can: vi.fn(async () => true),
  } as unknown as GrowthActor;
});
it('captures bounded server-owned fixtures, never contacts', async () => {
  const result = await captureRestaurantGrowthDraft(h, input, policy, binding);
  expect(result.attemptIds).toHaveLength(2);
  expect(write).toHaveBeenCalledTimes(2);
  expect(consent).toHaveBeenCalledTimes(2);
  expect(Object.keys(result).sort()).toEqual(['attemptIds', 'environment', 'replayed']);
  expect(result.attemptIds).not.toContain('c1');
});
it.each([
  { rolsuper: true },
  { rolbypassrls: true },
  { database: 'production' },
  { address: '10.0.0.1' },
  { port: 5432 },
])('rejects actual server mismatch %j', async (change) => {
  Object.assign(server, change);
  await expect(captureRestaurantGrowthDraft(h, input, policy, binding)).rejects.toMatchObject({
    code: 'DENIED',
  });
  expect(write).not.toHaveBeenCalled();
});
it.each(['INVENTORY_COST_REVIEW', 'CATERING_REVIEW'])(
  'never turns %s into outreach',
  async (kind) => {
    action = kind;
    await expect(captureRestaurantGrowthDraft(h, input, policy, binding)).rejects.toMatchObject({
      code: 'DENIED',
    });
    expect(write).not.toHaveBeenCalled();
  }
);
it('denies withdrawn current consent', async () => {
  consent.mockResolvedValue({ granted: false });
  expect((await captureRestaurantGrowthDraft(h, input, policy, binding)).attemptIds).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});
it('enforces explicit branch recipient rolling-day cap', async () => {
  count = 1;
  expect((await captureRestaurantGrowthDraft(h, input, policy, binding)).attemptIds).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});
it('quiet hours use configured timezone and midnight wrap', () => {
  expect(growthSandboxQuiet(new Date('2026-10-07T23:00:00Z'), policy)).toBe(true);
  expect(growthSandboxQuiet(new Date('2026-10-07T07:00:00Z'), policy)).toBe(true);
  expect(growthSandboxQuiet(new Date('2026-10-07T08:00:00Z'), policy)).toBe(false);
});
it('quiet hours prevent attempts', async () => {
  expect(
    (
      await captureRestaurantGrowthDraft(
        h,
        input,
        { ...policy, quietStart: 0, quietEnd: 23 },
        binding
      )
    ).attemptIds
  ).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});
it('UNKNOWN replay returns same attempt without resend', async () => {
  previous = [
    {
      id: 'attempt',
      customerId: 'c1',
      state: 'UNKNOWN',
      fingerprint: JSON.stringify({ actorId: 'u', input, policy, reviewId: 'r' }),
    },
  ];
  expect(await captureRestaurantGrowthDraft(h, input, policy, binding)).toMatchObject({
    attemptIds: ['attempt'],
    replayed: true,
  });
  expect(write).not.toHaveBeenCalled();
  expect(consent).not.toHaveBeenCalled();
});
it('rejects altered retries', async () => {
  previous = [{ id: 'attempt', customerId: 'c1', state: 'CAPTURED', fingerprint: 'other' }];
  await expect(captureRestaurantGrowthDraft(h, input, policy, binding)).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});
it('requires current review evidence even with persisted draft', async () => {
  mocks.read.mockResolvedValue({ status: 'STALE' });
  await expect(captureRestaurantGrowthDraft(h, input, policy, binding)).rejects.toMatchObject({
    code: 'STALE',
  });
  expect(write).not.toHaveBeenCalled();
});
it.each([' stop ', 'STOP', '\nStOp\t', 'ＳＴＯＰ', ' بند '])(
  'withdraws consent for %j and confirms with exactly one English line',
  async (text) => {
    const result = await stopRestaurantGrowthSandbox(
      h,
      { branchId: 'b', customerId: 'c1', eventId: input.requestId, text },
      policy
    );
    expect(mocks.consent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: 'WHATSAPP',
        granted: false,
        source: 'TEST_SANDBOX_STOP',
        actorId: 'u',
        policyVersion: 'TEST_V1',
        idempotencyKey: 'restaurant-growth-stop:' + input.requestId,
      })
    );
    expect(result.confirmation).toBe(
      'You will no longer receive WhatsApp growth messages. Reply START to opt back in.'
    );
    expect(result.confirmation).not.toContain('\n');
  }
);
it.each(['subscribe', 'بند کریں', '', '   '])(
  'does not accept inbound message %j',
  async (text) => {
    await expect(
      stopRestaurantGrowthSandbox(
        h,
        { branchId: 'b', customerId: 'c1', eventId: input.requestId, text },
        policy
      )
    ).rejects.toMatchObject({ code: 'INVALID' });
    expect(mocks.consent).not.toHaveBeenCalled();
  }
);
it('diagnostic keeps costs and money unknown and predicates exact receipt lineage', async () => {
  const result = await diagnoseRestaurantGrowthSandbox(
    h,
    { branchId: 'b', attemptId: input.requestId, cutoff: input.cutoff },
    policy
  );
  expect(result).toMatchObject({
    environment: 'TEST_SANDBOX',
    observational: true,
    messageCost: null,
    postedMarginMinor: null,
    settledSalesMinor: null,
    evidenceReceiptIds: [],
  });
  const sql = query.mock.calls.find(([sql]) => String(sql).startsWith('SELECT b.id'))![0];
  for (const predicate of [
    "a.state='CAPTURED'",
    "b.status='SETTLED'",
    'b."receiptNumber" IS NOT NULL',
    'o."customerId"=a."customerId"',
    'b."settledAt"<=',
  ])
    expect(sql).toContain(predicate);
  expect(write).not.toHaveBeenCalled();
});

it('rechecks anonymization and loyalty after customer lock', async () => {
  const previousQuery = query.getMockImplementation()!;
  query.mockImplementation((sql: string, ...args: unknown[]) =>
    sql.includes('SELECT c.id') ? [] : previousQuery(sql, ...args)
  );
  expect((await captureRestaurantGrowthDraft(h, input, policy, binding)).attemptIds).toEqual([]);
  expect(consent).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it('requires customer management capability', async () => {
  vi.mocked(h.can).mockImplementation(async (action) => action !== 'customers:manage');
  await expect(captureRestaurantGrowthDraft(h, input, policy, binding)).rejects.toMatchObject({
    code: 'DENIED',
  });
  expect(write).not.toHaveBeenCalled();
});
