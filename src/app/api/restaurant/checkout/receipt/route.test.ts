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
import { DEFAULT_RECEIPT_LAYOUT, type ReceiptLayout } from '@/lib/receipts/configuration';
import { buildReceiptPreview } from '@/lib/receipts/preview';
import { PrintDocumentSchema } from '@/lib/restaurant/printing/contract';

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
    discountTotal: decimal('0.50'),
    serviceChargeBasis: decimal('20'),
    serviceChargeRate: decimal('0.05'),
    serviceChargeTaxTreatment: 'EXCLUSIVE',
    taxTransactionSnapshots: [],
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
        taxAmount: decimal('2'),
        serviceChargeAmount: decimal('1'),
      },
    ],
    tenders: [
      {
        id: 'tender-1',
        type: 'CASH',
        amount: decimal('26.05'),
        tipAmount: decimal('1.50'),
        changeGiven: decimal('3.95'),
        cashReceived: decimal('30'),
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
let layout: ReceiptLayout;
const findLayout = vi.fn();
const findBill = vi.fn();
const createJob = vi.fn();
const lock = vi.fn();

beforeEach(() => {
  jobs = [];
  receipt = bill();
  configured = true;
  allowed = true;
  layout = { ...DEFAULT_RECEIPT_LAYOUT, paperWidth: 58, footerText: 'Saved footer' };
  vi.clearAllMocks();
  findLayout.mockImplementation(async ({ where }) =>
    where.organizationId === 'org-1' && where.id === 'branch-1' && where.active
      ? { receiptLayout: layout, receiptLayoutRevision: 1 }
      : null
  );
  findBill.mockImplementation(async ({ where }) =>
    where.id === receipt?.id &&
    where.branchId === receipt?.branchId &&
    (where.status === undefined || where.status === 'SETTLED')
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
      restaurantBill: { findFirst: findBill, findFirstOrThrow: findBill },
      restaurantBranch: { findFirst: findLayout },
      restaurantStaffProfile: {
        findUnique: async () => ({
          status: 'ACTIVE',
          primaryBranchId: 'branch-1',
          jobRoles: [],
          directCapabilityGrants: [],
          user: {
            permissionOverrides: [],
            organizationRole: {
              permissions: allowed ? [{ capability: 'payments:collect', effect: 'ALLOW' }] : [],
            },
          },
        }),
      },
      restaurantStaffJobRole: { findMany: async () => [] },
      restaurantStaffCapabilityGrant: { findMany: async () => [] },
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
      receiptSnapshot: {
        layout,
        facts: {
          lines: [
            expect.stringContaining(
              '2 x Meal @ 12.00\nLine subtotal 24.00 / Comp 4.00 / Line total 20.00'
            ),
          ],
        },
      },
    });
    const snapshot = PrintDocumentSchema.parse(jobs[0].document).receiptSnapshot!;
    const footer = buildReceiptPreview(snapshot.layout, snapshot.facts);
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
      'Discount 0.50',
      'Line tax 2.00',
      'Cash received 30.00',
    ])
      expect(footer.replaceAll('\n', ' ')).toContain(fact);
    expect(createJob.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org-1',
      branchId: 'branch-1',
      stationId: null,
      printerId: 'queue:///Receipt',
    });
    expect(findLayout).toHaveBeenCalledWith({
      where: { id: 'branch-1', organizationId: 'org-1', active: true },
      select: { receiptLayout: true, receiptLayoutRevision: true },
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
  it('captures new saved settings but preserves prior queued layout and exact browser preview', async () => {
    await post();
    const captured = structuredClone(jobs[0].document);
    layout = { ...layout, paperWidth: 80, footerText: 'Changed after enqueue' };
    const replay = await (await post()).json();
    expect(jobs[0].document).toEqual(captured);
    const snapshot = PrintDocumentSchema.parse(captured).receiptSnapshot!;
    expect(replay.preview).toEqual({
      text: buildReceiptPreview(snapshot.layout, snapshot.facts),
      paperWidth: 58,
      source: 'queued',
      validation: null,
    });
    jobs[0].status = 'PRINTED';
    await post(copy);
    expect(PrintDocumentSchema.parse(jobs[1].document).receiptSnapshot).toMatchObject({
      layout,
      facts: {
        invoiceNumber: '7 - COPY',
        totals: expect.arrayContaining([`Reprint: ${copy.reason}`]),
      },
    });
  });
  it('prints and previews a fractional bill with no persisted bill lines', async () => {
    Object.assign(receipt!, {
      splitKind: 'FRACTIONAL',
      fractionNumerator: 1,
      fractionDenominator: 3,
      lines: [],
    });
    const previewResponse = await GET(
      new Request('https://tenant.test/api/restaurant/checkout/receipt?billId=bill-1')
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview.lines).toEqual([]);
    expect(preview.totals.grandTotal).toBe('26.05');
    expect(preview.printing.preview).toMatchObject({
      source: 'saved',
      text: expect.stringContaining('Fractional share 1/3: 26.05'),
      validation: null,
    });

    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ latestJob: { status: 'PENDING' } });
    expect(jobs).toHaveLength(1);
    const facts = PrintDocumentSchema.parse(jobs[0].document).receiptSnapshot!.facts;
    expect(facts.lines).toEqual(['Fractional share 1/3: 26.05']);
    expect(facts.totals).toContain('Split FRACTIONAL 1/3');
    expect(facts.payments).toEqual(['CASH 26.05 / Tip 1.50 / Change 3.95 / Cash received 30.00']);

    const replay = await (await post()).json();
    expect(replay).toMatchObject({ latestJob: { status: 'PENDING' }, replayed: true });
    expect(replay.preview).toMatchObject({
      source: 'queued',
      text: expect.stringContaining('Fractional share 1/3: 26.05'),
      validation: null,
    });
    expect(jobs).toHaveLength(1);

    jobs[0].status = 'PRINTED';
    expect((await post(copy)).status).toBe(200);
    expect(jobs).toHaveLength(2);
    const reprintFacts = PrintDocumentSchema.parse(jobs[1].document).receiptSnapshot!.facts;
    expect(reprintFacts.lines).toEqual(['Fractional share 1/3: 26.05']);
    expect(reprintFacts.totals).toContain(`Reprint: ${copy.reason}`);
  });
  it('preserves persisted lines on a fractional bill', async () => {
    Object.assign(receipt!, {
      splitKind: 'FRACTIONAL',
      fractionNumerator: 1,
      fractionDenominator: 3,
    });

    await post();

    const facts = PrintDocumentSchema.parse(jobs[0].document).receiptSnapshot!.facts;
    expect(facts.lines).toEqual([
      '2 x Meal @ 12.00\nLine subtotal 24.00 / Comp 4.00 / Line total 20.00\nLine tax 2.00 / Line service 1.00',
    ]);
  });
  it('does not synthesize a receipt line for a non-fractional bill', async () => {
    Object.assign(receipt!, { lines: [] });

    const response = await post();

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'INVALID_PRINT_DOCUMENT' });
    expect(jobs).toHaveLength(0);
  });
  it('fails closed when an empty fractional bill has incomplete fraction metadata', async () => {
    Object.assign(receipt!, {
      splitKind: 'FRACTIONAL',
      fractionNumerator: 1,
      fractionDenominator: null,
      lines: [],
    });

    const response = await post();

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'INVALID_PRINT_DOCUMENT' });
    expect(jobs).toHaveLength(0);
  });
  it('preserves saved tax currency, rate buckets and discount allocations', async () => {
    findBill.mockResolvedValue({
      ...receipt,
      taxTransactionSnapshots: [
        {
          transactionReference: 'tax-original',
          currency: 'PKR',
          buckets: [
            {
              paymentCategory: 'CASH',
              priceMode: 'EXCLUSIVE',
              rate: decimal('0.1'),
              taxableAmount: decimal('20'),
              taxAmount: decimal('2'),
              grossAmount: decimal('22'),
              preDiscountGrossAmount: decimal('24'),
              beforeTaxDiscountAmount: decimal('1'),
              afterTaxDiscountAmount: decimal('0.50'),
            },
          ],
        },
      ],
    });
    await post();
    const facts = PrintDocumentSchema.parse(jobs[0].document).receiptSnapshot!.facts;
    expect(facts.taxLines).toEqual([
      'Tax 2.00',
      'Tax reference tax-original / Currency PKR',
      'CASH / EXCLUSIVE / Rate 0.1\nTaxable 20.00 / Tax 2.00 / Gross 22.00\nPre-discount gross 24.00 / Before-tax discount 1.00 / After-tax discount 0.50',
    ]);
  });
  it('preserves shared Urdu layout and logical Unicode text but refuses raw queue acceptance', async () => {
    const get = () =>
      GET(new Request('https://tenant.test/api/restaurant/checkout/receipt?billId=bill-1'));
    const ascii = await (await get()).json();
    expect(ascii.printing.preview).toMatchObject({
      paperWidth: 58,
      source: 'saved',
      text: expect.stringContaining('Saved footer'),
    });
    const name = '<img src=x> اردو e\u0301 𐐀 👩‍🍳';
    receipt!.lines[0].name = name;
    receipt!.branch.name = 'کاروبار';
    layout = { ...layout, businessText: 'پتہ', headerText: 'خوش آمدید', footerText: 'شکریہ' };
    const unicode = await (await get()).json();
    expect(unicode.lines[0].name).toBe(name);
    expect(unicode.printing.preview).toMatchObject({
      paperWidth: 58,
      validation: { code: 'UNSUPPORTED_PRINT_TEXT', fallback: 'BROWSER_OS' },
    });
    for (const fact of [name, 'کاروبار', 'پتہ', 'خوش آمدید', 'شکریہ', 'Discount 0.50'])
      expect(unicode.printing.preview.text).toContain(fact);
    expect(unicode.printing.preview).not.toHaveProperty('plainText');
    const rejected = await post();
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({
      error: 'Unsupported printer text. Use a browser/OS-rendered receipt.',
      code: 'UNSUPPORTED_PRINT_TEXT',
      fallback: 'BROWSER_OS',
    });
    expect(jobs).toHaveLength(0);
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
  it('compares the entire captured reprint reason even when it contains a second reason label', async () => {
    await post();
    jobs[0].status = 'PRINTED';
    expect((await post({ ...copy, reason: 'First reason\nReprint: Second reason' })).status).toBe(
      200
    );
    expect((await post({ ...copy, reason: 'Second reason' })).status).toBe(409);
  });
  it('fails closed on corrupt saved layouts without creating a job', async () => {
    findLayout.mockResolvedValue({
      receiptLayout: { ...layout, paperWidth: 42 },
      receiptLayoutRevision: 1,
    });
    expect(await (await post()).json()).toMatchObject({
      code: 'INVALID_PRINT_DOCUMENT',
      fallback: null,
    });
    expect(jobs).toHaveLength(0);
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
    receipt!.branchId = 'other-branch';
    expect((await post()).status).toBe(404);
    receipt = null;
    expect((await post()).status).toBe(404);
    expect(lock).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });
  it('does not disclose bill existence before the payment capability gate', async () => {
    allowed = false;
    const existing = await post({ billId: 'bill-1', action: 'print' });
    const missing = await post({ billId: 'missing-bill', action: 'print' }, 'missing-key');
    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(await existing.json()).toEqual(await missing.json());
    expect(findBill).not.toHaveBeenCalled();
  });
  it('returns the same not-found response for foreign and nonexistent bills after authorization', async () => {
    receipt!.branchId = 'other-branch';
    const foreign = await post({ billId: 'bill-1', action: 'print' });
    const missing = await post({ billId: 'missing-bill', action: 'print' }, 'missing-key');
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
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
    expect(findLayout).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });
  it('rejects missing idempotency headers and client money/routing fields', async () => {
    expect((await post(undefined, '')).status).toBe(400);
    for (const field of [
      'totals',
      'branchId',
      'printerId',
      'document',
      'receiptSnapshot',
      'layout',
      'facts',
    ])
      expect((await post({ billId: 'bill-1', action: 'print', [field]: 'untrusted' })).status).toBe(
        400
      );
    expect(createJob).not.toHaveBeenCalled();
  });
  it.each(['اردو', 'x'.repeat(2001), 'bad\u001bname'])(
    'rejects an unsupported label instead of corrupting receipt facts',
    async (name) => {
      receipt!.lines[0].name = name;
      expect((await post()).status).toBe(422);
      expect(createJob).not.toHaveBeenCalled();
    }
  );
  it.each(['bad\u001bname', 'x'.repeat(2001)])(
    'invalid facts receive no browser fallback: %s',
    async (name) => {
      receipt!.lines[0].name = name;
      expect(await (await post()).json()).toMatchObject({
        code: 'INVALID_PRINT_DOCUMENT',
        fallback: null,
      });
      const response = await GET(
        new Request('https://tenant.test/api/restaurant/checkout/receipt?billId=bill-1')
      );
      expect((await response.json()).printing.preview).toMatchObject({
        text: null,
        validation: { code: 'INVALID_PRINT_DOCUMENT', fallback: null },
      });
      expect(jobs).toHaveLength(0);
    }
  );
  it('returns scoped receipt preview/status with no-store and no raw job document exposure', async () => {
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
