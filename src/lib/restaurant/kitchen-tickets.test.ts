/**
 * M4-L2 (KOT) — unit tests for kitchen-ticket generation. Exercises the REAL
 * `generateKitchenTickets` against a small in-memory transaction fake so the
 * routing/grouping/per-(station, businessDate) numbering logic is tested without a
 * database. The station-routing precedence itself is L1's contract; here we assert
 * that this lane wires it correctly and creates the ticket + line rows.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  generateKitchenTickets,
  kitchenTicketPrintJob,
  KitchenTicketError,
  type FiredItem,
} from './kitchen-tickets';

const BUSINESS_DATE = new Date('2026-08-19T00:00:00.000Z');

type Station = { id: string; isDefault: boolean; active: boolean };
type Rule = {
  stationId: string;
  productId: string | null;
  categoryId: string | null;
  course: number | null;
  priority: number;
  active: boolean;
};

/** A minimal in-memory tx that satisfies the surface generateKitchenTickets uses. */
function makeTx(stations: Station[], rules: Rule[]) {
  const tickets: Array<{
    id: string;
    orderId: string;
    stationId: string;
    businessDate: Date;
    ticketNumber: number;
  }> = [];
  const ticketItems: Array<{
    id: string;
    ticketId: string;
    orderItemId: string;
    quantity: number;
  }> = [];
  let ticketSeq = 0;
  let lineSeq = 0;

  const tx = {
    restaurantKitchenStation: {
      findMany: async ({ where }: { where: { branchId: string; active?: boolean } }) =>
        stations
          .filter((s) => (where.active ? s.active : true))
          .map((s) => ({ id: s.id, isDefault: s.isDefault })),
    },
    restaurantStationRoutingRule: {
      findMany: async () =>
        rules
          .filter((r) => r.active)
          .map((r) => ({
            stationId: r.stationId,
            productId: r.productId,
            categoryId: r.categoryId,
            course: r.course,
            priority: r.priority,
          })),
    },
    restaurantKitchenTicket: {
      findFirst: async ({ where }: { where: { stationId: string; businessDate: Date } }) => {
        const forStation = tickets
          .filter(
            (t) =>
              t.stationId === where.stationId &&
              t.businessDate.getTime() === where.businessDate.getTime()
          )
          .sort((a, b) => b.ticketNumber - a.ticketNumber);
        return forStation[0] ?? null;
      },
      create: async ({ data }: { data: Omit<(typeof tickets)[number], 'id'> }) => {
        const row = { id: `ticket_${++ticketSeq}`, ...data };
        tickets.push(row);
        return { id: row.id };
      },
    },
    restaurantKitchenTicketItem: {
      create: async ({ data }: { data: Omit<(typeof ticketItems)[number], 'id'> }) => {
        const row = { id: `line_${++lineSeq}`, ...data };
        ticketItems.push(row);
        return { id: row.id };
      },
    },
  } as unknown as ScopedDb;

  return { tx, tickets, ticketItems };
}

const fired = (over: Partial<FiredItem> & Pick<FiredItem, 'orderItemId'>): FiredItem => ({
  productId: 'prod_default',
  categoryId: null,
  course: 1,
  quantity: 1,
  ...over,
});

describe('generateKitchenTickets', () => {
  it('builds a deterministic post-transaction print hand-off', () => {
    expect(
      kitchenTicketPrintJob(
        {
          ticketId: 'ticket_7',
          stationId: 'bar',
          ticketNumber: 7,
          createdAt: new Date('2026-08-29T08:00:00.000Z'),
          matchedBy: 'product',
          items: [{ orderItemId: 'lime', quantity: 2 }],
        },
        {
          branchId: 'branch_1',
          orderReference: 'Order 42',
          createdAt: '2026-08-29T08:00:00.000Z',
          documentType: 'BAR_TICKET',
          labelsByOrderItemId: { lime: 'Lime soda' },
        }
      )
    ).toMatchObject({
      idempotencyKey: 'kitchen-ticket:ticket_7:v1',
      stationId: 'bar',
      document: { type: 'BAR_TICKET', title: 'BAR', lines: [{ quantity: 2, label: 'Lime soda' }] },
    });
  });

  it('returns nothing when there is nothing to fire', async () => {
    const { tx } = makeTx([{ id: 'grill', isDefault: true, active: true }], []);
    const result = await generateKitchenTickets(tx, {
      orderId: 'o1',
      branchId: 'b1',
      businessDate: BUSINESS_DATE,
      items: [],
    });
    expect(result).toEqual([]);
  });

  it('routes items to the default station and creates a ticket + line rows', async () => {
    const { tx, tickets, ticketItems } = makeTx(
      [{ id: 'grill', isDefault: true, active: true }],
      []
    );
    const result = await generateKitchenTickets(tx, {
      orderId: 'o1',
      branchId: 'b1',
      businessDate: BUSINESS_DATE,
      items: [fired({ orderItemId: 'i1', quantity: 2 }), fired({ orderItemId: 'i2' })],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ stationId: 'grill', ticketNumber: 1, matchedBy: 'default' });
    expect(result[0].items).toEqual([
      { orderItemId: 'i1', quantity: 2 },
      { orderItemId: 'i2', quantity: 1 },
    ]);
    expect(tickets).toHaveLength(1);
    expect(ticketItems).toHaveLength(2);
  });

  it('groups items by resolved station (product rule beats default)', async () => {
    const { tx } = makeTx(
      [
        { id: 'grill', isDefault: true, active: true },
        { id: 'bar', isDefault: false, active: true },
      ],
      [
        {
          stationId: 'bar',
          productId: 'mojito',
          categoryId: null,
          course: null,
          priority: 0,
          active: true,
        },
      ]
    );
    const result = await generateKitchenTickets(tx, {
      orderId: 'o1',
      branchId: 'b1',
      businessDate: BUSINESS_DATE,
      items: [
        fired({ orderItemId: 'food', productId: 'steak' }),
        fired({ orderItemId: 'drink', productId: 'mojito' }),
      ],
    });
    expect(result).toHaveLength(2);
    const bar = result.find((t) => t.stationId === 'bar')!;
    const grill = result.find((t) => t.stationId === 'grill')!;
    expect(bar.matchedBy).toBe('product');
    expect(bar.items).toEqual([{ orderItemId: 'drink', quantity: 1 }]);
    expect(grill.items).toEqual([{ orderItemId: 'food', quantity: 1 }]);
  });

  it('numbers tickets sequentially per (station, businessDate)', async () => {
    const { tx } = makeTx([{ id: 'grill', isDefault: true, active: true }], []);
    const first = await generateKitchenTickets(tx, {
      orderId: 'o1',
      branchId: 'b1',
      businessDate: BUSINESS_DATE,
      items: [fired({ orderItemId: 'i1' })],
    });
    const second = await generateKitchenTickets(tx, {
      orderId: 'o2',
      branchId: 'b1',
      businessDate: BUSINESS_DATE,
      items: [fired({ orderItemId: 'i2' })],
    });
    expect(first[0].ticketNumber).toBe(1);
    expect(second[0].ticketNumber).toBe(2);
  });

  it('throws NO_STATION when an item cannot be routed and there is no default', async () => {
    const { tx } = makeTx([{ id: 'bar', isDefault: false, active: true }], []);
    await expect(
      generateKitchenTickets(tx, {
        orderId: 'o1',
        branchId: 'b1',
        businessDate: BUSINESS_DATE,
        items: [fired({ orderItemId: 'i1', productId: 'steak' })],
      })
    ).rejects.toBeInstanceOf(KitchenTicketError);
  });
});
