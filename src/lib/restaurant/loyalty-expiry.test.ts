import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  expireAccountLoyaltyPoints,
  loyaltyExpiryHandler,
  planLoyaltyExpiries,
} from './loyalty-expiry';

const AT = new Date('2026-08-21T00:00:00.000Z');
const BEFORE = new Date('2026-08-01T00:00:00.000Z');

describe('FIFO loyalty expiry', () => {
  it('expires only remaining earned lots after FIFO redemption and linked reversal', () => {
    const lots = planLoyaltyExpiries(
      [
        {
          id: 'earn_1',
          kind: 'EARN',
          points: 10,
          programVersionId: 'program_1',
          reversesEntryId: null,
          expiresAt: BEFORE,
          occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'earn_2',
          kind: 'EARN',
          points: 10,
          programVersionId: 'program_1',
          reversesEntryId: null,
          expiresAt: BEFORE,
          occurredAt: new Date('2026-02-01T00:00:00.000Z'),
        },
        {
          id: 'redeem_1',
          kind: 'REDEEM',
          points: -12,
          programVersionId: 'program_1',
          reversesEntryId: null,
          expiresAt: null,
          occurredAt: new Date('2026-03-01T00:00:00.000Z'),
        },
        {
          id: 'reverse_1',
          kind: 'REVERSAL',
          points: -3,
          programVersionId: 'program_1',
          reversesEntryId: 'earn_2',
          expiresAt: null,
          occurredAt: new Date('2026-04-01T00:00:00.000Z'),
        },
      ],
      AT
    );
    expect(lots.map(({ id, remaining }) => ({ id, remaining }))).toEqual([
      { id: 'earn_2', remaining: 5 },
    ]);
  });

  it('appends one negative entry pinned to each due earn lot', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'expiry_1' });
    const db = {
      loyaltyPointsEntry: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'earn_1',
            kind: 'EARN',
            points: 7,
            programVersionId: 'program_1',
            reversesEntryId: null,
            expiresAt: BEFORE,
            occurredAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ]),
        create,
      },
    } as unknown as ScopedDb;
    await expect(expireAccountLoyaltyPoints(db, 'account_1', AT)).resolves.toEqual({
      entries: 1,
      points: 7,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'EXPIRY',
        points: -7,
        reversesEntryId: 'earn_1',
        idempotencyKey: 'loyalty:expiry:earn_1',
      }),
    });
  });

  it('strictly rejects unknown scheduler payload keys', async () => {
    await expect(
      loyaltyExpiryHandler({
        db: {} as ScopedDb,
        job: { payload: { now: AT.toISOString(), extra: true } } as never,
      })
    ).rejects.toThrow();
  });
});
