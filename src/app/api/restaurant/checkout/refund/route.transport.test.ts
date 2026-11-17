import { Prisma } from '@/generated/prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readOptions: null as null | { run: (ctx: unknown) => Promise<Response> },
  mutationOptions: null as null | { run: (args: unknown) => Promise<unknown> },
  refundTender: vi.fn(),
  resolveApprover: vi.fn(),
}));

vi.mock('@/lib/restaurant/checkout-routes', () => ({
  moneyReadRoute: (options: typeof mocks.readOptions) => {
    mocks.readOptions = options;
    return vi.fn();
  },
  moneyMutationRoute: (options: typeof mocks.mutationOptions) => {
    mocks.mutationOptions = options;
    return vi.fn();
  },
  refundBody: {},
  resolveApprover: mocks.resolveApprover,
  resolveDemoApproverIdentity: vi.fn().mockResolvedValue(null),
  operatorHasCapability: vi.fn(),
  serializeRefundResult: (value: unknown) => value,
}));
vi.mock('@/lib/restaurant/refunds', () => ({ refundTender: mocks.refundTender }));

await import('./route');

describe('refund route transport of the machine refund reference', () => {
  beforeEach(() => {
    mocks.refundTender.mockReset().mockResolvedValue({ ok: true });
    mocks.resolveApprover.mockReset().mockResolvedValue({ ok: true, staffProfileId: 'mgr' });
  });

  it('GET exposes the payment provider so the UI can identify MANUAL card tenders', async () => {
    const decimal = (value: string) => new Prisma.Decimal(value);
    const tender = {
      id: 't1',
      type: 'CARD',
      payment: { provider: 'MANUAL' },
      amount: decimal('10.00'),
      tipAmount: decimal('0.00'),
      createdAt: new Date('2026-08-19T10:00:00Z'),
      bill: { receiptNumber: 'R1', order: { orderNumber: 7 } },
      refunds: [],
    };
    const response = await mocks.readOptions!.run({
      db: { restaurantTender: { findMany: vi.fn().mockResolvedValue([tender]) } },
      device: { branchId: 'b1' },
    });
    const body = await response.json();
    expect(body.tenders[0].paymentProvider).toBe('MANUAL');
  });

  it('POST forwards the reference to the refund command and keeps it optional', async () => {
    const run = (data: Record<string, unknown>) =>
      mocks.mutationOptions!.run({
        ctx: { db: {}, device: { branchId: 'b1' } },
        data: {
          originalTenderId: 't1',
          amount: '5.00',
          reason: 'x',
          approving: {},
          ...data,
        },
        actor: { staffProfileId: 'a' },
        now: new Date(),
      });
    await run({ cardMachineRefundReference: 'BANK-REF-42' });
    expect(mocks.refundTender).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ cardMachineRefundReference: 'BANK-REF-42' })
    );
    await run({});
    expect(mocks.refundTender.mock.calls.at(-1)![1].cardMachineRefundReference).toBeUndefined();
  });
});
