import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import type { TerminalContext } from '@/lib/restaurant/terminal-auth';

const mocks = vi.hoisted(() => ({ ctx: {} as TerminalContext, event: vi.fn() }));
// Exercise the real money capability/body gates; authentication and DB are test seams.
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  withTerminalAuth:
    (handler: (ctx: TerminalContext, request: Request) => Promise<Response>) =>
    (request: Request) =>
      handler(mocks.ctx, request),
}));
vi.mock('@/lib/restaurant/outbox', () => ({ appendOrderEvent: mocks.event }));

import { GET, POST } from './route';

const decimal = (value: string) => new Prisma.Decimal(value);
function bill() {
  return {
    id: 'bill-1',
    orderId: 'order-1',
    branchId: 'branch-1',
    businessDate: new Date('2026-09-05'),
    receiptNumber: 7,
    settledAt: new Date('2026-09-05T10:00:00Z'),
    splitKind: 'NONE',
    fractionNumerator: null,
    fractionDenominator: null,
    branch: { name: 'Main', timezone: 'UTC' },
    order: { orderNumber: 42, channel: 'DINE_IN' },
    subtotal: decimal('24'),
    taxTotal: decimal('2'),
    serviceChargeTotal: decimal('1'),
    deliveryFeeTotal: decimal('3'),
    compTotal: decimal('4'),
    roundingAdjustment: decimal('0.05'),
    grandTotal: decimal('26.05'),
    lines: [
      {
        id: 'line-1',
        name: 'Meal',
        quantity: 2,
        unitPrice: decimal('12'),
        lineSubtotal: decimal('24'),
        compAmount: decimal('4'),
        lineTotal: decimal('20'),
      },
    ],
    tenders: [
      {
        id: 'tender-1',
        type: 'CASH',
        amount: decimal('26.05'),
        tipAmount: decimal('1.50'),
        changeGiven: decimal('3.95'),
      },
    ],
  };
}

type Job = {
  id: string;
  idempotencyKey: string;
  document: unknown;
  status: string;
  printerId: string;
  attemptCount: number;
};
let jobs: Job[];
let receipt: ReturnType<typeof bill> | null;
let configured: boolean;
let allowed: boolean;
const findBill = vi.fn();
const createJob = vi.fn();
const lock = vi.fn();

beforeEach(() => {
  jobs = [];
  receipt = bill();
  configured = true;
  allowed = true;
  vi.clearAllMocks();
  findBill.mockImplementation(async ({ where }) =>
    where.id === receipt?.id && where.branchId === receipt?.branchId && where.status === 'SETTLED'
      ? receipt
      : null
  );
  createJob.mockImplementation(async ({ data }) => {
    const job = { ...data, id: `job-${jobs.length + 1}`, status: 'PENDING', attemptCount: 0 };
    jobs.push(job);
    return job;
  });
  mocks.ctx = {
    organizationId: 'org-1',
    device: { id: 'register-1', name: 'Counter', branchId: 'branch-1', kind: 'POS' },
    state: 'UNLOCKED',
    session: { activeStaffProfileId: 'staff-1' },
    db: {
      $executeRawUnsafe: lock,
      restaurantBill: { findFirst: findBill },
      restaurantStaffProfile: {
        findUnique: async () => ({
          user: {
            permissionOverrides: [],
            organizationRole: {
              permissions: allowed ? [{ capability: 'payments:collect', effect: 'ALLOW' }] : [],
            },
          },
        }),
      },
      restaurantPrintRoute: {
        findFirst: async () => (configured ? { printerId: 'queue:///Receipt' } : null),
      },
      restaurantPrintJob: {
        findFirst: async () => jobs.at(-1) ?? null,
        findUnique: async ({
          where,
        }: {
          where: { organizationId_branchId_idempotencyKey: { idempotencyKey: string } };
        }) =>
          jobs.find(
            (job) =>
              job.idempotencyKey === where.organizationId_branchId_idempotencyKey.idempotencyKey
          ) ?? null,
        create: createJob,
      },
    },
  } as unknown as TerminalContext;
});

function post(
  body: Record<string, unknown> = { billId: 'bill-1', action: 'print' },
  key = 'test-key'
) {
  return POST(
    new Request('https://tenant.test/api/restaurant/checkout/receipt', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify(body),
    })
  );
}
const copy = {
  billId: 'bill-1',
  action: 'reprint',
  reason: 'Customer requested copy',
  requestId: 'd9a09326-8048-47c8-8e24-74d6b34b81ce',
};

describe('Restaurant receipt dispatch', () => {
  it('queues canonical saved totals/tenders, branch routing, and actor attribution', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].document).toMatchObject({
      type: 'RECEIPT',
      lines: [{ quantity: 2, label: 'Meal @ 12.00 = 20.00 (comp 4.00)' }],
    });
    const footer = (jobs[0].document as { footer: string }).footer;
    for (const fact of [
      'Subtotal 24.00',
      'Delivery 3.00',
      'Service 1.00',
      'Tax 2.00',
      'Comp 4.00',
      'Rounding 0.05',
      'TOTAL 26.05',
      'CASH 26.05',
      'Tip 1.50',
      'Change 3.95',
    ])
      expect(footer).toContain(fact);
    expect(createJob.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org-1',
      branchId: 'branch-1',
      stationId: null,
      printerId: 'queue:///Receipt',
    });
    expect(mocks.event).toHaveBeenCalledWith(
      mocks.ctx.db,
      expect.objectContaining({
        actorStaffProfileId: 'staff-1',
        actorDeviceId: 'register-1',
        eventType: 'receipt.print_requested',
      })
    );
  });
  it('deduplicates first prints across transport keys and preserves offline status after routing removal', async () => {
    await post();
    jobs[0].status = 'OFFLINE';
    configured = false;
    const response = await post(undefined, 'another-transport-key');
    expect(await response.json()).toMatchObject({
      replayed: true,
      latestJob: { status: 'OFFLINE' },
    });
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(mocks.event).toHaveBeenCalledTimes(1);
  });
  it('requires an explicit reason, deduplicates reprint request IDs, and rejects changed retry reasons', async () => {
    await post();
    jobs[0].status = 'PRINTED';
    expect((await post({ ...copy, reason: '' })).status).toBe(400);
    expect((await post(copy)).status).toBe(200);
    expect(jobs).toHaveLength(2);
    expect((jobs[1].document as { title: string }).title).toContain('COPY');
    expect((await post(copy, 'fresh-header')).status).toBe(200);
    expect(jobs).toHaveLength(2);
    expect((await post({ ...copy, reason: 'Changed reason' })).status).toBe(409);
    expect(mocks.event).toHaveBeenLastCalledWith(
      mocks.ctx.db,
      expect.objectContaining({
        eventType: 'receipt.reprint_requested',
        payload: expect.objectContaining({ reason: copy.reason }),
      })
    );
  });
  it.each(['PENDING', 'OFFLINE', 'NO_PRINTER'])(
    'refuses another copy when existing delivery is %s',
    async (status) => {
      await post();
      jobs[0].status = status;
      expect((await post(copy)).status).toBe(409);
      expect(jobs).toHaveLength(1);
    }
  );
  it('does not enqueue when no receipt route exists', async () => {
    configured = false;
    expect(await (await post()).json()).toMatchObject({ outcome: 'NO_PRINTER', latestJob: null });
    expect(createJob).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it('rejects cross-branch and missing/unsettled bills before queue access', async () => {
    mocks.ctx.device.branchId = 'other-branch';
    expect((await post()).status).toBe(404);
    receipt = null;
    expect((await post()).status).toBe(404);
    expect(lock).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });
  it('requires an unlocked operator, payment capability, and POS register', async () => {
    mocks.ctx.state = 'LOCKED';
    expect((await post()).status).toBe(409);
    mocks.ctx.state = 'UNLOCKED';
    allowed = false;
    expect((await post()).status).toBe(403);
    allowed = true;
    mocks.ctx.device.kind = 'KDS';
    expect((await post()).status).toBe(403);
    expect(findBill).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });
  it('rejects missing idempotency headers and client money/routing fields', async () => {
    expect((await post(undefined, '')).status).toBe(400);
    for (const field of ['totals', 'branchId', 'printerId', 'document'])
      expect((await post({ billId: 'bill-1', action: 'print', [field]: 'untrusted' })).status).toBe(
        400
      );
    expect(createJob).not.toHaveBeenCalled();
  });
  it.each(['اردو', 'x'.repeat(170), 'bad\u001bname'])(
    'rejects an unsupported label instead of corrupting receipt facts',
    async (name) => {
      receipt!.lines[0].name = name;
      expect((await post()).status).toBe(422);
      expect(createJob).not.toHaveBeenCalled();
    }
  );
  it('returns scoped receipt status with no-store and no print document exposure', async () => {
    await post();
    const response = await GET(
      new Request('https://tenant.test/api/restaurant/checkout/receipt?billId=bill-1')
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      billId: 'bill-1',
      printing: { registerName: 'Counter', branchId: 'branch-1' },
    });
    expect(findBill).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 'bill-1', branchId: 'branch-1', status: 'SETTLED' } })
    );
  });
});
