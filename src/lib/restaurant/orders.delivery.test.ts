import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { openOrder } from './orders';

describe('openOrder delivery fail-closed guard', () => {
  it('rejects delivery before opening a transaction or writing idempotency/order rows', async () => {
    const transaction = vi.fn();
    const db = { $transaction: transaction } as never;

    await expect(
      openOrder(db, {
        organizationId: 'org-1',
        entitlementLimits: { 'pos.orders.monthly': 1000000 },
        branchId: 'branch-1',
        channel: 'DELIVERY',
        actor: {
          staffProfileId: 'staff-1',
          deviceId: 'device-1',
          idempotencyKey: 'delivery-attempt-1',
        },
      })
    ).rejects.toMatchObject({
      reason: 'CHANNEL_UNAVAILABLE',
      message: 'Delivery is not configured. Use dine-in or takeaway.',
    });

    expect(transaction).not.toHaveBeenCalled();
  });
});
