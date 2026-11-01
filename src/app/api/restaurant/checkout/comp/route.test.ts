import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/restaurant/bills', () => ({ compLine: vi.fn() }));
vi.mock('@/lib/restaurant/checkout-routes', () => ({ moneyMutationRoute: vi.fn() }));

import { compLine } from '@/lib/restaurant/bills';
import { moneyMutationRoute } from '@/lib/restaurant/checkout-routes';
import { POST } from './route';

describe('checkout comp route', () => {
  it('unconditionally refuses comp requests before authentication or persistence', async () => {
    const response = await POST();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Complimentary items are not available in this version.',
    });
    expect(moneyMutationRoute).not.toHaveBeenCalled();
    expect(compLine).not.toHaveBeenCalled();
  });
});
