import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { hasModule } from '@/lib/entitlements';
import { recordTrpcAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

// Frozen tender schema from base 483a2685, independent of the extracted production schema.
const originalTenderSchema = z
  .object({
    branchId: z.string().trim().min(1).max(128),
    saleId: z.string().min(1),
    deviceId: z.string().min(1),
    businessDate: z.date(),
    type: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET', 'CREDIT']),
    amountMinor: z.number().int().positive(),
    cashReceivedMinor: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().trim().min(1).max(160),
  })
  .strict();
const input = {
  branchId: 'branch-1',
  saleId: 'sale-1',
  deviceId: 'device-1',
  businessDate: new Date('2026-09-12T14:15:16.123Z'),
  type: 'CASH' as const,
  amountMinor: 100,
  cashReceivedMinor: 150,
  idempotencyKey: 'attempt-1',
};
const stored = { tenderId: 'tender-1', settled: false, receiptNumber: null, remainingMinor: 200 };
const app = router({ pharmacySales: pharmacySalesRouter });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(raw: unknown = input) {
  const parsed = originalTenderSchema.parse(raw);
  const prior = {
    id: 'idem-1',
    organizationId: 'org-1',
    deviceId: parsed.deviceId,
    key: parsed.idempotencyKey,
    commandType: 'tender',
    payloadHash: digest(parsed),
    resultPayload: stored,
  };
  const cash = parsed.type === 'CASH' ? (parsed.cashReceivedMinor ?? parsed.amountMinor) : null;
  const unexpected = vi.fn(() => {
    throw new Error('Unexpected database operation');
  });
  const only = (entries: Record<string, unknown>) =>
    new Proxy(entries, { get: (target, key) => target[String(key)] ?? unexpected });
  const saleRead = vi.fn().mockResolvedValue({
    id: parsed.saleId,
    organizationId: 'org-1',
    branchId: parsed.branchId,
  });
  const keyRead = vi.fn().mockResolvedValue(prior);
  const tenderRead = vi.fn().mockResolvedValue({
    id: 'tender-1',
    organizationId: 'org-1',
    branchId: parsed.branchId,
    saleId: parsed.saleId,
    deviceId: parsed.deviceId,
    type: parsed.type,
    amountMinor: parsed.amountMinor,
    businessDate: new Date('2026-09-12T00:00:00.000Z'),
    cashReceivedMinor: cash,
    changeGivenMinor: cash === null ? null : cash - parsed.amountMinor,
  });
  // Only compatibility tests call the old mutation. Its idempotency hit avoids domain work.
  const execute = vi.fn().mockResolvedValue(0);
  const transaction = vi.fn(async (callback) => callback(db));
  const db = only({
    pharmacyBranch: only({
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: 'branch-1' })),
    }),
    // Tender requires canonical counter access plus a branch assignment.
    user: only({
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
        permissionOverrides: [],
      })),
    }),
    pharmacyBranchAssignment: only({
      findMany: vi.fn(async () => [{ branchId: 'branch-1' }]),
    }),
    pharmacySale: only({ findFirst: saleRead }),
    pharmacyMoneyIdempotencyKey: only({ findUnique: keyRead }),
    pharmacyTender: only({ findFirst: tenderRead }),
    // CAM-2: no evidence camera in this branch, so no still is requested.
    camera: only({ findFirst: vi.fn().mockResolvedValue(null) }),
    $executeRaw: execute,
    $transaction: transaction,
  });
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  const caller = (overrides: Partial<TRPCContext> = {}) =>
    app.createCaller({ ...context, ...overrides }).pharmacySales;
  const noWrites = () => {
    expect(unexpected).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(recordTrpcAudit).not.toHaveBeenCalled();
  };
  return {
    parsed,
    prior,
    saleRead,
    keyRead,
    tenderRead,
    execute,
    transaction,
    unexpected,
    context,
    caller,
    noWrites,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasModule).mockReturnValue(true);
});

describe('pharmacySales.tenderOutcome', () => {
  it.each([stored, { tenderId: 'tender-1', settled: true, receiptNumber: 41, remainingMinor: 0 }])(
    'reads the exact accepted result through the real query: %j',
    async (result) => {
      const f = fixture();
      f.keyRead.mockResolvedValue({ ...f.prior, resultPayload: result });
      expect(pharmacySalesRouter._def.procedures.tenderOutcome._def.type).toBe('query');
      expect(await f.caller().tenderOutcome(input)).toEqual({
        status: 'ACCEPTED',
        replayUnsafe: true,
        result,
      });
      expect(hasModule).toHaveBeenCalledWith(f.context.entitlements, 'pharmacy-counter');
      f.noWrites();
    }
  );

  it.each([
    { label: 'anonymous', override: { session: null }, code: 'UNAUTHORIZED' },
    {
      label: 'inactive',
      override: { session: { expires: 'later', user: { id: 'actor-1', status: 'SUSPENDED' } } },
      code: 'FORBIDDEN',
    },
    {
      label: 'missing actor',
      override: { session: { expires: 'later', user: { status: 'ACTIVE' } } },
      code: 'UNAUTHORIZED',
    },
    {
      label: 'missing tenant',
      override: { entitlements: { enabledModules: ['pharmacy-counter'], modules: [] } },
      code: 'UNAUTHORIZED',
    },
  ])('denies $label before any evidence read', async ({ override, code }) => {
    const f = fixture();
    await expect(
      f.caller(override as Partial<TRPCContext>).tenderOutcome(input)
    ).rejects.toMatchObject({ code });
    expect(f.saleRead).not.toHaveBeenCalled();
    expect(f.keyRead).not.toHaveBeenCalled();
    f.noWrites();
  });

  it('requires the counter module before reading evidence', async () => {
    const f = fixture();
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(f.caller().tenderOutcome(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.saleRead).not.toHaveBeenCalled();
    expect(f.keyRead).not.toHaveBeenCalled();
    f.noWrites();
  });

  it('refuses a foreign branch before reading sale or key evidence', async () => {
    const f = fixture();
    await expect(
      f.caller().tenderOutcome({ ...input, branchId: 'foreign-branch' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.saleRead).not.toHaveBeenCalled();
    expect(f.keyRead).not.toHaveBeenCalled();
    f.noWrites();
  });

  it('does not look up keys for a foreign sale', async () => {
    const f = fixture();
    f.saleRead.mockResolvedValue(null);
    expect(await f.caller().tenderOutcome({ ...input, saleId: 'foreign-sale' })).toEqual({
      status: 'UNKNOWN',
      replayUnsafe: true,
    });
    expect(f.saleRead.mock.calls[0][0].where).toEqual({
      id: 'foreign-sale',
      organizationId: 'org-1',
      branchId: input.branchId,
    });
    expect(f.keyRead).not.toHaveBeenCalled();
    f.noWrites();
  });

  it('refuses a changed tenant without that tenant’s branch membership', async () => {
    const f = fixture();
    await expect(
      f
        .caller({
          entitlements: { ...f.context.entitlements, organizationId: 'org-2' },
        })
        .tenderOutcome(input)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.saleRead).not.toHaveBeenCalled();
    expect(f.keyRead).not.toHaveBeenCalled();
    f.noWrites();
  });

  it.each([
    { amountMinor: 101 },
    { cashReceivedMinor: 151 },
    { deviceId: 'other-device' },
    { idempotencyKey: 'other-key' },
    { businessDate: new Date('2026-09-12T14:15:16.124Z') },
  ])('keeps conflicting evidence unknown: %j', async (change) => {
    const f = fixture();
    expect(await f.caller().tenderOutcome({ ...input, ...change })).toEqual({
      status: 'UNKNOWN',
      replayUnsafe: true,
    });
    expect(f.tenderRead).not.toHaveBeenCalled();
    f.noWrites();
  });

  it.each(['absent', 'empty', 'malformed', 'missing-tender', 'read-failure'])(
    'keeps %s evidence unsafe',
    async (kind) => {
      const f = fixture();
      if (kind === 'absent') f.keyRead.mockResolvedValue(null);
      if (kind === 'empty') f.keyRead.mockResolvedValue({ ...f.prior, resultPayload: null });
      if (kind === 'malformed') f.keyRead.mockResolvedValue({ ...f.prior, resultPayload: {} });
      if (kind === 'missing-tender') f.tenderRead.mockResolvedValue(null);
      if (kind === 'read-failure')
        f.keyRead.mockRejectedValue(new Error('sensitive database details'));
      expect(await f.caller().tenderOutcome(input)).toEqual({
        status: kind === 'absent' ? 'NOT_FOUND' : 'UNKNOWN',
        replayUnsafe: true,
      });
      f.noWrites();
    }
  );

  const invalid = [
    { businessDate: '2026-09-12' },
    { businessDate: new Date('invalid') },
    { branchId: ' ' },
    { saleId: '' },
    { deviceId: '' },
    { idempotencyKey: ' ' },
    { type: 'OTHER' },
    { amountMinor: 0 },
    { amountMinor: 1.5 },
    { cashReceivedMinor: null },
    { cashReceivedMinor: -1 },
    { organizationId: 'foreign-tenant' },
    { adapter: {} },
  ];
  it.each(invalid)('retains strict original validation: %j', async (change) => {
    const f = fixture();
    const raw = { ...input, ...change };
    expect(originalTenderSchema.safeParse(raw).success).toBe(false);
    await expect(f.caller().tenderOutcome(raw as typeof input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(f.saleRead).not.toHaveBeenCalled();
    f.noWrites();
    await expect(f.caller().tender(raw as typeof input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  const { cashReceivedMinor: omittedCash, ...withoutCash } = input;
  void omittedCash;
  it('keeps legacy CREDIT evidence readable without allowing a new unscoped credit', async () => {
    const raw = { ...input, type: 'CREDIT' as const, cashReceivedMinor: undefined };
    const f = fixture(raw);
    expect(await f.caller().tenderOutcome(raw)).toMatchObject({ status: 'ACCEPTED' });
    await expect(f.caller().tender(raw)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
    expect(recordTrpcAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
  });

  it.each([
    input,
    withoutCash,
    { ...input, cashReceivedMinor: undefined },
    Object.fromEntries(Object.entries(input).reverse()),
    { ...input, branchId: ' branch-1 ', idempotencyKey: ' attempt-1 ' },
    { ...input, type: 'BANK_TRANSFER', cashReceivedMinor: 0 },
    { ...input, type: 'CARD' },
    { ...input, type: 'WALLET' },
  ])('preserves the old mutation serialized input and hash: %j', async (raw) => {
    const f = fixture(raw);
    expect(await f.caller().tender(raw as typeof input)).toEqual({ ...stored, replayed: true });
    const query = f.execute.mock.calls[0][0] as { values: unknown[] };
    expect(query.values.slice(1)).toEqual([
      'org-1',
      f.parsed.deviceId,
      f.parsed.idempotencyKey,
      'tender',
      digest(f.parsed),
    ]);
    const mutationParser = pharmacySalesRouter._def.procedures.tender._def.inputs[0] as z.ZodType;
    const lookupParser = pharmacySalesRouter._def.procedures.tenderOutcome._def
      .inputs[0] as z.ZodType;
    for (const parser of [mutationParser, lookupParser]) {
      const parsed = parser.parse(raw);
      expect(parsed).toStrictEqual(f.parsed);
      expect(Object.keys(parsed as object)).toEqual(Object.keys(f.parsed));
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(f.parsed));
    }
    f.execute.mockClear();
    f.transaction.mockClear();
    vi.mocked(recordTrpcAudit).mockClear();
    expect(await f.caller().tenderOutcome(raw as typeof input)).toEqual({
      status: 'ACCEPTED',
      replayUnsafe: true,
      result: stored,
    });
    f.noWrites();
  });

  it('pins full timestamp, optional omission and field-order serialization', () => {
    expect(JSON.stringify(originalTenderSchema.parse(input))).toBe(
      '{"branchId":"branch-1","saleId":"sale-1","deviceId":"device-1","businessDate":"2026-09-12T14:15:16.123Z","type":"CASH","amountMinor":100,"cashReceivedMinor":150,"idempotencyKey":"attempt-1"}'
    );
    expect(digest(originalTenderSchema.parse(withoutCash))).toBe(
      digest(originalTenderSchema.parse({ ...input, cashReceivedMinor: undefined }))
    );
    expect(digest(originalTenderSchema.parse(input))).not.toBe(
      digest(originalTenderSchema.parse(withoutCash))
    );
  });
});
