/**
 * M4-L4 — unit tests for the KDS read-model projection and the fixed KDS action
 * mapping. These exercise the PURE cores (`projectStationQueue`, `kdsActionToStatus`)
 * with no database: the cursor high-water mark, the two gap conditions (a regressed
 * sequence after a missed window, and an overflowed poll window), the level-triggered
 * open-queue filtering + FIFO order, the fixed L1 item→display mapping, and that a KDS
 * action only ever names a legal item-domain target status.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

import {
  KDS_ACTION_TRANSITIONS,
  kdsActionToStatus,
  projectStationQueue,
  readStationQueue,
  type StationTicketInput,
} from './kds';
import { KDS_DISPLAY_BY_ITEM_STATUS, type OrderItemStatus } from './order-state-machine';

const DATE = new Date('2026-08-19T00:00:00.000Z');

function ticket(
  ticketNumber: number,
  statuses: OrderItemStatus[],
  overrides: Partial<StationTicketInput> = {}
): StationTicketInput {
  return {
    ticketId: `tkt_${ticketNumber}`,
    ticketNumber,
    orderId: `ord_${ticketNumber}`,
    orderNumber: 100 + ticketNumber,
    createdAt: new Date(DATE.getTime() + ticketNumber * 1000),
    items: statuses.map((status, i) => ({
      orderItemId: `oi_${ticketNumber}_${i}`,
      name: `Item ${i}`,
      modifierNames: [],
      course: 1,
      seatNumber: null,
      quantity: 1,
      itemStatus: status,
    })),
    ...overrides,
  };
}

function project(
  tickets: StationTicketInput[],
  opts: { sinceCursor?: number; limit?: number } = {}
) {
  return projectStationQueue({
    stationId: 'stn_1',
    businessDate: DATE,
    sinceCursor: opts.sinceCursor ?? null,
    limit: opts.limit ?? 50,
    tickets,
  });
}

describe('projectStationQueue — open queue projection', () => {
  it('returns only tickets with at least one non-cleared line, oldest-first (FIFO)', () => {
    const queue = project([
      ticket(3, ['QUEUED']),
      ticket(1, ['SERVED', 'VOIDED']), // fully cleared → excluded
      ticket(2, ['FIRING', 'SERVED']), // one open line → included
    ]);
    expect(queue.tickets.map((t) => t.ticketNumber)).toEqual([2, 3]);
  });

  it('maps every line onto its fixed L1 KDS display status', () => {
    const queue = project([ticket(1, ['QUEUED', 'FIRING', 'PREPARED', 'REMAKE_REQUESTED'])]);
    const displays = queue.tickets[0]!.items.map((i) => i.displayStatus);
    expect(displays).toEqual([
      KDS_DISPLAY_BY_ITEM_STATUS.QUEUED, // NEW
      KDS_DISPLAY_BY_ITEM_STATUS.FIRING, // COOKING
      KDS_DISPLAY_BY_ITEM_STATUS.PREPARED, // READY
      KDS_DISPLAY_BY_ITEM_STATUS.REMAKE_REQUESTED, // RECALLED
    ]);
    expect(queue.displayMapping).toBe(KDS_DISPLAY_BY_ITEM_STATUS);
  });

  it('rolls a ticket up to its least-advanced open line', () => {
    // A ticket with a QUEUED and a PREPARED line reads NEW (least advanced), and a
    // cleared line never drags the rollup backwards.
    expect(project([ticket(1, ['PREPARED', 'QUEUED', 'SERVED'])]).tickets[0]!.displayStatus).toBe(
      'NEW'
    );
    expect(project([ticket(1, ['PREPARED', 'SERVED'])]).tickets[0]!.displayStatus).toBe('READY');
  });

  it('sets the cursor to the station ticket-number high-water mark', () => {
    const queue = project([
      ticket(1, ['QUEUED']),
      ticket(5, ['SERVED', 'VOIDED']),
      ticket(3, ['FIRING']),
    ]);
    // Even the fully-cleared #5 counts toward the high-water mark.
    expect(queue.cursor).toBe(5);
  });
});

describe('projectStationQueue — bounded polling cursor + gap detection', () => {
  it('reports no gap on a normal incremental poll', () => {
    const queue = project([ticket(1, ['QUEUED']), ticket(2, ['FIRING'])], { sinceCursor: 0 });
    expect(queue.gap).toBe(false);
    expect(queue.hasMore).toBe(false);
    expect(queue.cursor).toBe(2);
  });

  it('detects a gap after a missed window (cursor regressed below the current max)', () => {
    // The screen was offline across the business-day cutoff; its cursor (250, from
    // yesterday) now exceeds today's max ticket number (3) → full reconcile.
    const queue = project([ticket(1, ['QUEUED']), ticket(2, ['FIRING']), ticket(3, ['QUEUED'])], {
      sinceCursor: 250,
    });
    expect(queue.gap).toBe(true);
    expect(queue.cursor).toBe(3);
  });

  it('detects a gap when the open queue overflows the poll window, and bounds the page', () => {
    const queue = project(
      [ticket(1, ['QUEUED']), ticket(2, ['QUEUED']), ticket(3, ['QUEUED']), ticket(4, ['QUEUED'])],
      { sinceCursor: 0, limit: 2 }
    );
    expect(queue.hasMore).toBe(true);
    expect(queue.gap).toBe(true);
    expect(queue.tickets.map((t) => t.ticketNumber)).toEqual([1, 2]); // FIFO, bounded
    expect(queue.cursor).toBe(4); // high-water still reflects everything present
  });

  it('handles an empty station (no tickets) without a spurious gap', () => {
    const queue = project([], { sinceCursor: 0 });
    expect(queue.tickets).toEqual([]);
    expect(queue.cursor).toBe(0);
    expect(queue.gap).toBe(false);
  });
});

describe('kdsActionToStatus — fixed action → item-domain target', () => {
  it('maps ack→FIRING, bump→PREPARED, recall→FIRING', () => {
    expect(kdsActionToStatus('ACK')).toBe('FIRING');
    expect(kdsActionToStatus('BUMP')).toBe('PREPARED');
    expect(kdsActionToStatus('RECALL')).toBe('FIRING');
  });

  it('only ever names legal forward kitchen targets (FIRING/PREPARED)', () => {
    for (const target of Object.values(KDS_ACTION_TRANSITIONS)) {
      expect(['FIRING', 'PREPARED']).toContain(target);
    }
  });
});

describe('readStationQueue — station name from the existing ticket query', () => {
  it.each(['QUEUED', 'SERVED', null] as const)(
    'loads the name before projecting tickets (%s)',
    async (status) => {
      const findMany = vi.fn().mockResolvedValue(
        status === null
          ? []
          : [
              {
                id: 'tkt_1',
                ticketNumber: 1,
                orderId: 'ord_1',
                createdAt: DATE,
                order: { orderNumber: 101 },
                station: { name: 'Hot Kitchen' },
                items: [
                  {
                    orderItemId: 'oi_1',
                    quantity: 1,
                    orderItem: {
                      name: 'Soup',
                      modifiers: [],
                      course: 1,
                      seatNumber: null,
                      status,
                    },
                  },
                ],
              },
            ]
      );
      const db = { restaurantKitchenTicket: { findMany } } as unknown as ScopedDb;

      const queue = await readStationQueue(db, {
        stationId: 'stn_1',
        businessDate: DATE,
        limit: 50,
      });

      expect(findMany).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          where: { stationId: 'stn_1', businessDate: DATE },
          select: expect.objectContaining({ station: { select: { name: true } } }),
        })
      );
      expect(queue.stationName).toBe(status === null ? null : 'Hot Kitchen');
      expect(queue.tickets).toHaveLength(status === 'QUEUED' ? 1 : 0);
    }
  );
});
