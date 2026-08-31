import { describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => vi.fn());
vi.mock('@/lib/restaurant/terminal-delivery-dispatch', () => ({ deliveryQueueRoute: route }));

import { GET } from './route';

describe('KDS delivery queue route', () => {
  it('exports the authenticated delivery queue handler', () => {
    expect(GET).toBe(route);
  });
});
