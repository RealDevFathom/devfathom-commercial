import { describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => vi.fn());
vi.mock('@/lib/restaurant/terminal-delivery-dispatch', () => ({ deliveryTransitionRoute: route }));

import { POST } from './route';

describe('KDS delivery transition route', () => {
  it('exports the authenticated delivery transition handler', () => {
    expect(POST).toBe(route);
  });
});
