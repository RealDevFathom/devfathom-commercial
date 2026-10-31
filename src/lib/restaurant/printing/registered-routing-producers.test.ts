// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  receipt: vi.fn(),
  layout: vi.fn(),
  appendEvent: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/printing/service', () => ({
  PrintBridgeService: class {
    enqueue = h.enqueue;
  },
}));
vi.mock('@/lib/restaurant/checkout-routes', () => ({ buildReceiptForBranch: h.receipt }));
vi.mock('@/lib/receipts/restaurant-settings', () => ({ getRestaurantReceiptLayout: h.layout }));
vi.mock('@/lib/restaurant/outbox', () => ({ appendOrderEvent: h.appendEvent }));
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { enqueueKitchenTicketPrintJobs } from '@/lib/restaurant/kitchen-tickets';
import {
  dispatchReceipt,
  receiptPrintState,
} from '@/app/api/restaurant/checkout/receipt/receipt-dispatch';

const target = 'tcp://raw-target:9100';
const now = new Date('2026-10-14T12:00:00Z');
function project(row: Record<string, unknown>, select: Record<string, boolean>) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => select[key] === true));
}
const receipt = {
  billId: 'bill',
  orderId: 'order',
  orderNumber: 1,
  channel: 'DINE_IN',
  branchId: 'branch',
  branchName: 'Restaurant',
  businessDate: '2026-10-14',
  receiptNumber: 'R-1',
  settledAt: now,
  splitKind: 'FULL',
  fractionNumerator: null,
  fractionDenominator: null,
  lines: [
    {
      id: 'line',
      name: 'Lunch',
      quantity: 1,
      unitPrice: '10.00',
      lineSubtotal: '10.00',
      compAmount: '0.00',
      lineTotal: '10.00',
    },
  ],
  tenders: [],
  totals: {
    subtotal: '10.00',
    taxTotal: '0.00',
    serviceChargeTotal: '0.00',
    deliveryFeeTotal: '0.00',
    compTotal: '0.00',
    roundingAdjustment: '0.00',
    grandTotal: '10.00',
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  h.enqueue.mockResolvedValue({ status: 'QUEUED', printerId: target, replayed: false });
  h.receipt.mockResolvedValue(receipt);
  h.layout.mockResolvedValue({ layout: DEFAULT_RECEIPT_LAYOUT, revision: 1 });
  h.appendEvent.mockResolvedValue(undefined);
});
it.each(['registered-printer', null])(
  'kitchen preserves registry reference %s and raw target through its projection',
  async (registeredPrinterId) => {
    const route = {
      documentType: 'KITCHEN_TICKET',
      stationId: 'station',
      printerId: target,
      registeredPrinterId,
      enabled: true,
    };
    const findMany = vi.fn(async ({ select }: { select: Record<string, boolean> }) => [
      project(route, select),
    ]);
    const tx = { restaurantPrintRoute: { findMany } } as unknown as Parameters<
      typeof enqueueKitchenTicketPrintJobs
    >[0];
    const count = await enqueueKitchenTicketPrintJobs(tx, {
      organizationId: 'org',
      branchId: 'branch',
      orderReference: 'ORDER-1',
      labelsByOrderItemId: { line: 'Lunch' },
      tickets: [
        {
          ticketId: 'ticket',
          stationId: 'station',
          ticketNumber: 1,
          createdAt: now,
          matchedBy: 'default',
          items: [{ orderItemId: 'line', quantity: 1 }],
        },
      ],
    });
    expect(count).toBe(1);
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(
      'org',
      { branchId: 'branch', routes: [route] },
      expect.objectContaining({
        branchId: 'branch',
        stationId: 'station',
        idempotencyKey: 'kitchen-ticket:ticket:v1',
      })
    );
  }
);
it.each(['registered-printer', null])(
  'receipt state and dispatch preserve registry reference %s and raw target',
  async (registeredPrinterId) => {
    const route = { printerId: target, registeredPrinterId };
    const findFirst = vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
      project(route, select)
    );
    const db = {
      restaurantPrintRoute: { findFirst },
      restaurantPrintJob: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      restaurantBill: {
        findFirstOrThrow: vi.fn().mockResolvedValue({
          discountTotal: 0,
          serviceChargeBasis: 0,
          serviceChargeRate: null,
          serviceChargeTaxTreatment: null,
          lines: [{ id: 'line', taxAmount: 0, serviceChargeAmount: 0 }],
          tenders: [],
          taxTransactionSnapshots: [],
        }),
      },
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    };
    const ctx = {
      organizationId: 'org',
      device: { id: 'register', name: 'Front register', branchId: 'branch', kind: 'POS' },
      db,
    } as unknown as Parameters<typeof receiptPrintState>[0];
    expect(
      await receiptPrintState(ctx, receipt as unknown as Parameters<typeof receiptPrintState>[1])
    ).toMatchObject({ printerId: target, registeredPrinterId });
    const result = await dispatchReceipt({
      ctx,
      data: { billId: 'bill', action: 'print' },
      actor: { staffProfileId: 'staff' },
      now,
    } as Parameters<typeof dispatchReceipt>[0]);
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(
      'org',
      {
        branchId: 'branch',
        routes: [
          {
            documentType: 'RECEIPT',
            stationId: null,
            printerId: target,
            registeredPrinterId,
            enabled: true,
          },
        ],
      },
      expect.objectContaining({
        branchId: 'branch',
        stationId: null,
        document: expect.objectContaining({ type: 'RECEIPT' }),
      })
    );
    expect(result).toMatchObject({ outcome: 'QUEUED', replayed: false });
    expect(h.appendEvent).toHaveBeenCalledOnce();
  }
);
