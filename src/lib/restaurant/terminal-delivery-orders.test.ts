import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { DeliveryError } from './delivery';
import {
  attachDeliveryBody,
  deliveryAddressesQuery,
  deliveryErrorResponse,
} from './terminal-delivery-orders';

describe('terminal delivery contracts', () => {
  it('accepts only trusted object references and rejects a supplied payment mode', () => {
    const valid = {
      orderId: 'order-1',
      customerId: 'customer-1',
      addressId: 'address-1',
      zoneId: 'zone-1',
    };
    expect(attachDeliveryBody.safeParse(valid).success).toBe(true);
    expect(attachDeliveryBody.safeParse({ ...valid, paymentMode: 'PREPAID' }).success).toBe(false);
    expect(deliveryAddressesQuery.safeParse({ customerId: 'customer-1' }).success).toBe(true);
    expect(
      deliveryAddressesQuery.safeParse({ customerId: 'customer-1', branchId: 'branch-2' }).success
    ).toBe(false);
  });

  it('maps inactive zones and minimum failures to conflicts without leaking internals', async () => {
    for (const reason of ['INACTIVE_ZONE', 'MINIMUM_SUBTOTAL'] as const) {
      const response = deliveryErrorResponse(
        new DeliveryError('Delivery cannot be attached.', reason)
      );
      expect(response?.status).toBe(409);
      expect(await response?.json()).toEqual({ error: 'Delivery cannot be attached.', reason });
    }
    expect(deliveryErrorResponse(new Error('database details'))).toBeNull();
  });
});
