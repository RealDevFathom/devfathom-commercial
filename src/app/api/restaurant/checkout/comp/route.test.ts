import { describe, expect, it, vi } from 'vitest';

const compLine = vi.hoisted(() => vi.fn());

vi.mock('@/lib/restaurant/bills', () => ({ compLine }));

import { POST } from './route';

describe('checkout comp route', () => {
  it('fails closed without invoking the comp mutation', async () => {
    const response = await POST();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Comps are not available in the MVP.',
    });
    expect(compLine).not.toHaveBeenCalled();
  });
});
