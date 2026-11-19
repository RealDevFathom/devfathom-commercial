/**
 * DEV-956: the whole-bill discount is enforced on the server: the owner's switch, the open,
 * unpaid bill, the approval, and every line's own limits. A refusal writes nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { applyBillDiscount } from './bill-discount-service';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
const approval = {
  approvedByUserId: 'manager-a',
  approvalPolicy: 'MANAGER_PIN',
  selfApproved: false,
};

type Line = Record<string, unknown> & { id: string };
const otc = { rx: false, restricted: false, controlled: false };
function line(id: string, gross: number, cost: number, extra: Record<string, unknown> = {}): Line {
  return {
    id,
    createdAt: new Date(`2026-11-19T00:00:0${id.length % 10}Z`),
    grossMinor: gross,
    discountMinor: 0,
    billDiscountMinor: 0,
    tierDiscountMinor: 0,
    tierName: null,
    discountKind: null,
    voucherId: null,
    promotionId: null,
    medicine: otc,
    allocations: [
      {
        id: `${id}-a`,
        canonicalUnits: 1,
        grossMinor: gross,
        discountMinor: 0,
        lot: { unitCostMinor: cost },
      },
    ],
    ...extra,
  };
}

function db(
  options: {
    enabled?: boolean;
    status?: string;
    tender?: boolean;
    attempt?: boolean;
    lines?: Line[];
    maxDiscountBps?: number;
  } = {}
) {
  const lines = options.lines ?? [line('l1', 300, 0), line('l22', 333, 0)];
  return {
    organization: {
      findFirst: vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
        select.pharmacyBillDiscountEnabled
          ? { pharmacyBillDiscountEnabled: options.enabled ?? true }
          : { pharmacyMaxDiscountBps: options.maxDiscountBps ?? 10_000 }
      ),
    },
    pharmacyBranch: { findFirst: vi.fn(async () => ({ discountPolicy: null })) },
    $queryRaw: vi.fn(async () =>
      options.status === 'MISSING' ? [] : [{ status: options.status ?? 'OPEN' }]
    ),
    pharmacyTender: { findFirst: vi.fn(async () => (options.tender ? { id: 't1' } : null)) },
    pharmacyCardTerminalAttempt: {
      findFirst: vi.fn(async () => (options.attempt ? { id: 'c1' } : null)),
    },
    pharmacySaleLine: {
      findMany: vi.fn(async () => lines),
      update: vi.fn(async () => ({})),
    },
    pharmacySaleEvent: { create: vi.fn(async () => ({})) },
  };
}
const run = (
  fake: ReturnType<typeof db>,
  request: Parameters<typeof applyBillDiscount>[2]['request'],
  given = approval as typeof approval | null
) =>
  applyBillDiscount(fake as unknown as ScopedDb, scope, {
    saleId: 'sale-a',
    request,
    approval: given,
  });

describe('applyBillDiscount (DEV-956)', () => {
  it('is refused while the owner has not switched it on, before the bill is touched', async () => {
    const fake = db({ enabled: false });
    await expect(run(fake, { kind: 'AMOUNT', minor: 10 })).rejects.toMatchObject({
      reason: 'BILL_DISCOUNT_OFF',
    });
    expect(fake.$queryRaw).not.toHaveBeenCalled();
    expect(fake.pharmacySaleLine.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a tender of any kind (cash, card, khata or loyalty points)', { tender: true }],
    ['a card-terminal attempt that may have charged', { attempt: true }],
  ])('is refused once the bill has %s', async (_label, state) => {
    const fake = db(state);
    await expect(run(fake, { kind: 'AMOUNT', minor: 10 })).rejects.toMatchObject({
      reason: 'BILL_DISCOUNT_AFTER_PAYMENT',
    });
    expect(fake.pharmacySaleLine.update).not.toHaveBeenCalled();
  });

  it('is refused on a bill that is not open or not at this branch', async () => {
    await expect(run(db({ status: 'HELD' }), { kind: 'AMOUNT', minor: 10 })).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
    await expect(
      run(db({ status: 'MISSING' }), { kind: 'AMOUNT', minor: 10 })
    ).rejects.toMatchObject({ reason: 'CROSS_BRANCH_REFERENCE' });
  });

  it('needs an approval to give a discount, never to remove one', async () => {
    await expect(run(db(), { kind: 'AMOUNT', minor: 10 }, null)).rejects.toMatchObject({
      reason: 'APPROVAL_REQUIRED',
    });
    const fake = db({
      lines: [
        line('l1', 300, 0, {
          discountMinor: 30,
          billDiscountMinor: 30,
          discountKind: 'DISCOUNT',
          billAllocationDiscounts: { 'l1-a': 30 },
        }),
      ],
    });
    await expect(run(fake, { kind: 'AMOUNT', minor: 0 }, null)).resolves.toMatchObject({
      status: 'APPLIED',
      totalMinor: 0,
      previousTotalMinor: 30,
    });
    expect(fake.pharmacySaleLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          discountMinor: 0,
          billDiscountMinor: 0,
          discountKind: null,
          approvalPolicy: null,
          approvedByUserId: null,
        }),
      })
    );
    expect(fake.pharmacySaleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'REMOVED' }) })
    );
  });

  it("refuses a percentage above the owner's maximum like an item discount", async () => {
    await expect(
      run(db({ maxDiscountBps: 1_000 }), { kind: 'PERCENT', bps: 1_001 })
    ).rejects.toMatchObject({ reason: 'DISCOUNT_ABOVE_MAXIMUM' });
  });

  it('returns the most the bill can take and writes nothing when it cannot take it in full', async () => {
    const fake = db({ lines: [line('l1', 300, 250), line('l22', 333, 300)] });
    await expect(run(fake, { kind: 'AMOUNT', minor: 84 })).resolves.toEqual({
      status: 'REFUSED',
      reason: 'ABOVE_LIMIT',
      requestedMinor: 84,
      capacityMinor: 83,
      excluded: [],
    });
    expect(fake.pharmacySaleLine.update).not.toHaveBeenCalled();
    expect(fake.pharmacySaleEvent.create).not.toHaveBeenCalled();
  });

  it('counts the whole-line margin floor on a mixed-lot line, so it refuses with the true capacity instead of throwing', async () => {
    // Two lots at 100 costing 95 and 10, a 20% minimum margin: the lots have 0 + 87 room, but
    // the line must keep ceil(105 / 0.8) = 132, so it can take only 68.
    const mixed = {
      ...line('l1', 200, 0),
      allocations: [
        {
          id: 'l1-a',
          canonicalUnits: 1,
          grossMinor: 100,
          discountMinor: 0,
          lot: { unitCostMinor: 95 },
        },
        {
          id: 'l1-b',
          canonicalUnits: 1,
          grossMinor: 100,
          discountMinor: 0,
          lot: { unitCostMinor: 10 },
        },
      ],
    };
    const fake = db({ lines: [mixed] });
    fake.pharmacyBranch.findFirst.mockResolvedValue({ discountPolicy: { minMarginBps: 2_000 } });
    await expect(run(fake, { kind: 'AMOUNT', minor: 80 })).resolves.toMatchObject({
      status: 'REFUSED',
      reason: 'ABOVE_LIMIT',
      capacityMinor: 68,
    });
    expect(fake.pharmacySaleLine.update).not.toHaveBeenCalled();
    await expect(run(fake, { kind: 'AMOUNT', minor: 68 })).resolves.toMatchObject({
      status: 'APPLIED',
      totalMinor: 68,
    });
    expect(fake.pharmacySaleLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ billAllocationDiscounts: { 'l1-a': 0, 'l1-b': 68 } }),
      })
    );
  });

  it('writes each share with its lot snapshot and records who gave and who approved it', async () => {
    const voucher = line('l333', 500, 0, {
      discountMinor: 50,
      discountKind: 'VOUCHER',
      voucherId: 'v1',
    });
    const promotion = line('l4444', 500, 0, {
      discountMinor: 25,
      discountKind: 'PROMOTION',
      promotionId: 'p1',
    });
    const rx = line('l55555', 500, 0, { medicine: { ...otc, rx: true } });
    const fake = db({ lines: [line('l1', 300, 0), line('l22', 333, 0), voucher, promotion, rx] });
    const outcome = await run(fake, { kind: 'AMOUNT', minor: 101 });
    expect(outcome).toEqual({
      status: 'APPLIED',
      totalMinor: 101,
      previousTotalMinor: 0,
      lines: [
        { saleLineId: 'l1', discountMinor: 48 },
        { saleLineId: 'l22', discountMinor: 53 },
      ],
      excluded: [
        { saleLineId: 'l333', reason: 'OWN_DISCOUNT' },
        { saleLineId: 'l4444', reason: 'OWN_DISCOUNT' },
        { saleLineId: 'l55555', reason: 'REGULATED' },
      ],
    });
    // Voucher, promotion and regulated lines are never written.
    expect(fake.pharmacySaleLine.update).toHaveBeenCalledTimes(2);
    expect(fake.pharmacySaleLine.update).toHaveBeenCalledWith({
      where: { organizationId_id: { organizationId: 'org-a', id: 'l1' } },
      data: {
        discountMinor: 48,
        billDiscountMinor: 48,
        billAllocationDiscounts: { 'l1-a': 48 },
        discountKind: 'DISCOUNT',
        approvalPolicy: 'MANAGER_PIN',
        approvedByUserId: 'manager-a',
      },
    });
    expect(fake.pharmacySaleEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'BILL_DISCOUNT',
        actorId: 'cashier-a',
        reason: 'GIVEN',
        payload: expect.objectContaining({
          totalMinor: 101,
          givenByUserId: 'cashier-a',
          approvedByUserId: 'manager-a',
          approvalPolicy: 'MANAGER_PIN',
          selfApproved: false,
        }),
      }),
    });
  });

  it('records a solo owner’s self-approval as such', async () => {
    const fake = db();
    await run(
      fake,
      { kind: 'PERCENT', bps: 500 },
      {
        approvedByUserId: 'cashier-a',
        approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
        selfApproved: true,
      }
    );
    expect(fake.pharmacySaleEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          approvedByUserId: 'cashier-a',
          approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
          selfApproved: true,
        }),
      }),
    });
  });
});
